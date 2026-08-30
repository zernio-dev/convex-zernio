# Zernio outgoing webhooks: exact contract

Extracted from the Zernio monorepo source (authoritative). Every claim below is
traceable to one of:

- `libs/webhooks/delivery.ts` (signing, headers, enqueue, terminal accounting)
- `libs/webhooks/types.ts` (wire types)
- `libs/webhooks/event-catalog.ts` (subscribable event list)
- `libs/webhooks/post.webhook.ts`, `post-platform.webhook.ts`, `account.webhook.ts` (emitters)
- `libs/webhooks/post-payload.ts` (the shared `post` projection)
- `libs/webhooks/retry-schedule.ts`, `auto-disable.ts`, `circuit-breaker.ts`
- `workers/outgoing-webhook-consumer/src/index.ts` (the process that actually POSTs)
- `app/api/v1/webhooks/settings/route.ts`, `test/route.ts`, `logs/redeliver/route.ts`
- `models/Post.ts` (status enums)

Anything not derivable from those files is marked **AMBIGUOUS**.

---

## 1. Signature and headers

### Algorithm

HMAC-SHA256, lowercase hex, no prefix, no version tag, no timestamp component.

- Key: the subscription's `secret`, as raw UTF-8 bytes (`new TextEncoder().encode(secret)`
  in the worker, `crypto.createHmac('sha256', secret)` in Node).
- Message: `JSON.stringify(payload)`, where `payload` is the **entire envelope
  object** (id, event, timestamp, and the event-specific block), not a sub-field.
- Output: hex digest (`.digest('hex')` / hex-encoded `crypto.subtle.sign` result).

Node reference (`delivery.ts`):

```ts
crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex')
```

Worker reference (`workers/outgoing-webhook-consumer/src/index.ts`) computes the
identical value via `crypto.subtle` HMAC/SHA-256 over
`new TextEncoder().encode(JSON.stringify(payload))`.

The HTTP body is produced from the same object: the worker sends
`body: JSON.stringify(payload)` and the Node test/redeliver path hands the object
to `axios.post`, which serializes plain objects with `JSON.stringify`. So the raw
request body is byte-identical to the signed string, and a receiver should HMAC
the **raw request body** and compare (constant-time) with the header. Do not
re-serialize the parsed JSON before verifying: key order and number formatting
would have to round-trip exactly, which is not guaranteed.

If the subscription has no secret (the field is optional at create and defaults
to the empty string), **no signature header is sent at all**. A receiver that
requires signatures must reject unsigned deliveries itself.

### Headers on every delivery

| Header | Value | Always? |
| --- | --- | --- |
| `Content-Type` | `application/json` | yes |
| `X-Zernio-Event` | the event name, e.g. `post.published` | yes |
| `X-Late-Event` | same value as `X-Zernio-Event` (legacy alias) | yes |
| `User-Agent` | `Zernio-Webhooks/1.0` | yes |
| `X-Zernio-Event-Id` | `payload.id` (UUID v4) | when `payload.id` is set (always in practice) |
| `X-Late-Event-Id` | same value (legacy alias) | same condition |
| `X-Zernio-Signature` | hex HMAC-SHA256 as above | only when a secret is configured |
| `X-Late-Signature` | same value (legacy alias) | same condition |

The `X-Late-*` aliases carry byte-identical values to their `X-Zernio-*`
counterparts. Source comment: "Send both old (X-Late-\*) and new (X-Zernio-\*)
headers for backward compatibility. Old headers will be removed in a future major
version."

There is **no** timestamp header, no replay window, no signature scheme prefix
(nothing like Stripe's `t=...,v1=...`), and no delivery-attempt header. Attempt
number is not exposed to the receiver.

Any `customHeaders` configured on the subscription are merged **last**, so a
custom header can silently override `Content-Type`, `User-Agent`, the event
headers, or even the signature headers.

---

## 2. Envelope

Every payload extends `BaseWebhookPayload`:

```ts
{
  id: string;         // UUID v4, crypto.randomUUID(), per event, per fan-out
  event: string;      // the event name, same value as X-Zernio-Event
  timestamp: string;  // ISO-8601, new Date().toISOString(), set at fire time
  ...                 // one or more event-specific top-level keys
}
```

**There is no `data` wrapper.** The event-specific body is a set of top-level
keys named per family: `post`, `platform`, `account`, `sync`, and so on. A
consumer must switch on `event` and read the named block directly.

`id` is the same across all destinations of one fan-out: one emitted event
produces N queue messages (one per subscribed endpoint) that all carry the same
`payload.id`. Redelivery replays the original payload verbatim, so the same `id`
arrives again. A test fire mints a fresh `id`.

---

## 3. Payload shapes

### Shared `post` projection (`buildPostWebhookPost`)

Used identically by the `post.*` envelope events and the `post.platform.*`
events.

```ts
post: {
  id: string;             // Post _id as a string
  content: string;
  status: string;         // post-level status, see enum below
  scheduledFor: string;   // ISO-8601 (Mongo Date serialized by JSON.stringify)
  publishedAt?: string;   // ISO-8601; absent when the post has not published
  platforms: Array<{
    platform: string;       // e.g. 'twitter', 'instagram', 'tiktok'
    status: string;         // per-platform status, see enum below
    accountId?: string;     // SocialAccount id; absent on legacy/orphaned entries
    platformPostId?: string;
    publishedUrl?: string;  // mapped from Post.platforms[i].platformPostUrl
    error?: string;         // mapped from Post.platforms[i].errorMessage
  }>;
  metadata?: Record<string, unknown>; // key omitted entirely when nothing survives
}
```

Notes taken from source, not inferred:

- Field renames happen in the projection: `platformPostUrl` becomes
  `publishedUrl`, `errorMessage` becomes `error`.
- `metadata` is the caller's own object from create-post, with the internal keys
  `usageCounted`, `usageRefunded`, `hidden` stripped. If nothing remains, the
  `metadata` key is **absent**, not `{}`.
- Optional fields are omitted (JSON.stringify drops `undefined`); they are not
  sent as `null`.
- Post-level `status` enum (`models/Post.ts`): `draft`, `scheduled`,
  `publishing`, `published`, `partial`, `failed`, `cancelled`.
- Per-platform `status` enum (`models/Post.ts`): `pending`, `processing`,
  `published`, `failed`, `cancelled`, `uploading`.
- **AMBIGUOUS:** `scheduledFor` and `publishedAt` are typed `string` in
  `post-payload.ts` but are Mongoose `Date` values at runtime; they reach the
  wire as ISO-8601 strings via `JSON.stringify`. Treat them as ISO-8601 strings.

### `post.scheduled` / `post.published` / `post.failed` / `post.partial` / `post.cancelled`

All five share one shape (`PostWebhookPayload`); `post.recycled` is the sixth
member of the same union.

```jsonc
{
  "id": "…uuid…",
  "event": "post.published",   // or post.scheduled | post.failed | post.partial | post.cancelled
  "post": { /* the shared post projection above */ },
  "timestamp": "2026-08-30T10:00:00.000Z"
}
```

Required: `id`, `event`, `post`, `timestamp`. Inside `post`: `id`, `content`,
`status`, `scheduledFor`, `platforms` are always present; `publishedAt`,
`metadata`, and each per-platform optional field may be absent.

Firing rules (from `post.webhook.ts`):

- `post.scheduled` fires after a post transitions **into** the scheduled state
  (created non-draft, draft promoted or queued, failed post retried, recycled
  clone created). It does **not** fire on scheduled-to-scheduled edits or on
  internal recovery recalculations.
- `post.published`, `post.partial`, `post.failed`, `post.cancelled` are the
  post-level rollup, mapped one-to-one from `post.status` by
  `firePostStatusWebhook`. Statuses `scheduled` and `publishing` map to no
  event.

### `post.platform.published` / `post.platform.failed`

`PostPlatformWebhookPayload`. Same union also carries `post.platform.deleted`
and `post.tiktok.url_resolved`.

```jsonc
{
  "id": "…uuid…",
  "event": "post.platform.published",   // or post.platform.failed
  "post": { /* the shared post projection; status may still be "publishing" */ },
  "platform": {
    "name": "tiktok",                  // required; Post.platforms[i].platform
    "status": "published",             // required; 'published' | 'failed' | 'deleted'
    "platformPostId": "…",             // present on published and deleted; absent on failed
    "publishedUrl": "https://…",       // present on published (when the platform exposes one and it is not a draft) and on deleted (when recorded); absent on failed
    "error": "…",                      // present on failed only
    "deletedAt": "2026-…Z"             // ISO-8601; only on post.platform.deleted (detection time, not platform deletion time)
  },
  "account": {
    "accountId": "…",                  // required
    "platform": "tiktok",              // required
    "username": "…",                   // required
    "displayName": "…"                 // optional
  },
  "timestamp": "2026-08-30T10:00:00.000Z"
}
```

Required: `id`, `event`, `post`, `platform`, `account`, `timestamp`.

Firing rules (from `post-platform.webhook.ts` and `types.ts`):

- Fires once per platform target, at the moment that target reaches a terminal
  state, before the post-level rollup event.
- `post.platform.failed` fires **only for permanent failures**. Temporary,
  retryable failures are silent.
- The embedded `post.status` is read fresh from the DB at fire time and may be
  `publishing` while other targets are still running. Consumers must read it
  rather than assume a terminal value.
- One post fanned out to several accounts on the same platform fires one event
  per account write.

### `account.connected`

```jsonc
{
  "id": "…uuid…",
  "event": "account.connected",
  "account": {
    "accountId": "…",     // required
    "profileId": "…",     // required
    "platform": "instagram", // required
    "username": "…",      // required
    "displayName": "…"    // optional (absent when not supplied)
  },
  "timestamp": "2026-08-30T10:00:00.000Z"
}
```

### `account.disconnected`

Same account block plus two always-present fields:

```jsonc
{
  "id": "…uuid…",
  "event": "account.disconnected",
  "account": {
    "accountId": "…",
    "profileId": "…",
    "platform": "instagram",
    "username": "…",
    "displayName": "…",                // optional
    "disconnectionType": "unintentional", // required; 'intentional' | 'unintentional'
    "reason": "Token expired or revoked"  // required; emitter defaults to this exact string when the caller supplies none
  },
  "timestamp": "2026-08-30T10:00:00.000Z"
}
```

`reason` is free-form human-readable text, not an enum. Branch on
`disconnectionType`.

### Not requested but adjacent, for completeness

- `account.ads.initial_sync_completed` adds `account.platformUserId`,
  `account.profilePicture`, `account.platformAdAccountId`,
  `account.platformAdAccountIds` (all optional) plus a required `sync` block:
  `{ status: 'success' | 'failure', totalAds, synced, failed, error?, errorCode?,
  errorSubcode?, errorCategory? }` where `errorCategory` is one of
  `token_invalid`, `permission_denied`, `no_ad_accounts`, `rate_limited`,
  `discovery_failed`, `unknown`.
- `webhook.test` is `{ id, event: 'webhook.test', message: 'This is a test
  webhook from Zernio', timestamp }`.

---

## 4. Delivery semantics

### Path

Emitter builds the payload, `queueWebhookPayload` resolves every subscribed
endpoint across the team and enqueues **one Cloudflare Queue message per
endpoint**. The `outgoing-webhook-consumer` worker performs the HTTP POST and
reports each attempt's result back to the API.

The URL, secret, and custom headers are snapshotted into the queue message at
enqueue time, so a delivery uses the configuration that existed when the event
fired, not the configuration at delivery time.

### What counts as success

- Worker: `response.ok`, i.e. HTTP 200-299.
- Node test/redeliver path: `validateStatus: status >= 200 && status < 300`.

The response body is read (truncated to 10,000 characters) for logging only. Its
content is never interpreted. Any 2xx is accepted, so an empty `200` is the
cheapest correct reply. Redirects are not followed as success; only 2xx counts.

Per-attempt timeout: **5,000 ms** (worker `AbortController`, Node `axios` timeout).

### Retries

At-least-once. Maximum **7 attempts** total, including the immediate first one.
Delay before each attempt (`retry-schedule.ts`):

| Attempt | Delay before it |
| --- | --- |
| 1 | 0 (immediate) |
| 2 | 10 s |
| 3 | 100 s (1 m 40 s) |
| 4 | 1,000 s (16 m 40 s) |
| 5 | 10,000 s (2 h 46 m 40 s) |
| 6 | 86,400 s (24 h, cap) |
| 7 | 86,400 s (24 h, cap) |

Total span from first attempt to the last, about 51 hours.

Short-circuit: a response with a **permanent 4xx** status is terminal on the
first response, with no retries. Permanent means any 4xx **except 408 and 429**,
which stay retryable. 5xx, network errors, and timeouts run the full ladder.

**AMBIGUOUS:** in-repo comments disagree about the ladder's length. The worker
says "7 attempts over ~28 hours"; `auto-disable.ts` says "~51h"; the example
comment on `getWebhookRetryDelayMsForAttempt` says "attempt 3 waits 5 minutes"
while the table it reads from says 100 s. The **array in `retry-schedule.ts` is
the ground truth** and yields the table above (about 51 hours). Treat the prose
comments as stale.

### Ordering

**No ordering guarantee.** Reasons visible in source:

- A fan-out becomes N independent queue messages.
- Each message retries on its own schedule, so a retried event can land hours
  after a later event that succeeded first.
- The worker processes a batch message by message but the queue itself makes no
  ordering promise.

The only stated ordering is a *firing* order, not a delivery order:
`post.platform.*` events are fired before the corresponding post-level rollup
(`post.published` / `post.partial` / `post.failed`). Do not depend on them
arriving in that order.

### Idempotency: what the receiver must do

- **Dedupe key: `payload.id`, also delivered as the `X-Zernio-Event-Id` header
  (`X-Late-Event-Id` alias).** Persist processed ids and drop repeats.
- Scope the key per endpoint if one consumer serves several subscriptions: the
  same `id` is delivered to every subscribed endpoint of the account for one
  emitted event.
- A manual redelivery replays the **original** `id` deliberately, precisely so
  the consumer can dedupe it. If you want redeliveries to be reprocessed, that
  is an explicit choice you must make; the default correct behavior is to drop.
- Duplicates are expected, not exceptional: the worker ACKs after a successful
  POST but a failure to persist the delivery result does not un-send the POST,
  and CF Queues deliver at-least-once.
- Ordering-insensitive processing is required: treat each event as a statement
  about the state at `timestamp` and reconcile, rather than applying a sequence.
  For post state specifically, the embedded `post` block is a full projection
  read at fire time, so last-write-wins on `timestamp` is safe.

### Failure handling on the sender side (affects consumers)

- **Circuit breaker** (`circuit-breaker.ts`): once an endpoint has been failing
  continuously for 2 hours with no success, new events are **suppressed at
  enqueue time**, not queued. They are logged to the customer's webhook log with
  an explanatory message and are **never delivered**, not even later. Delivery
  resumes on its own when a probe succeeds (probes flow through once the last
  failed attempt goes 15 minutes stale). Practical consequence: a dead endpoint
  loses events permanently, and a consumer recovering from a long outage must
  backfill from the API, not from webhooks.
- **Auto-disable** (`auto-disable.ts`): after 20 consecutive terminal failures,
  or a failure streak lasting 3 days, and only when there has been no successful
  delivery in the last 3 days, the subscription is set `isActive: false`, the
  owner is emailed, and it must be re-enabled manually (which resets the failure
  counters). Any success within the 3-day window keeps a flapping endpoint
  enabled.
- **DLQ**: terminal failures are written to `dlqrecords` (`queue: 'webhook-dlq'`)
  with the full payload for manual review or replay.
- A subscription disabled after enqueue is honored on delivery, but only after a
  5-minute trust window on the enqueue-time snapshot; within that window the
  already-queued event is still delivered.

---

## 5. Subscribing

All routes are authenticated with the standard Zernio API auth (`authenticateApi`:
API key or session). Mutations additionally require the account owner or a
full-access team member; a profile-scoped API key is refused with
`insufficient_permissions`.

### Create a webhook, choose events, set the secret

`POST /v1/webhooks/settings`

```jsonc
{
  "name": "My endpoint",              // required, 1-50 chars
  "url": "https://example.com/hook",  // required, valid URL (trimmed before validation)
  "events": ["post.published", "post.failed"], // required, min 1, each from the event catalog
  "secret": "…",                      // optional; YOU choose it, Zernio does not generate one
  "isActive": true,                   // optional, default true
  "customHeaders": { "X-My-Tenant": "abc" },   // optional, string -> string
  "disabledResourceGroups": ["messages"]       // optional denylist of resource groups
}
```

Response: `{ "success": true, "webhook": { _id, name, url, secret, events,
disabledResourceGroups, isActive, customHeaders, failureCount } }`.

**The secret is supplied by the consumer, not issued by Zernio.** Omitting it
stores an empty string, which means deliveries carry no signature headers. To
obtain the secret later, list the subscriptions (`GET`), which returns the stored
value.

Limits and gates:

- Maximum 50 webhooks per account.
- Subscribing to `message.*`, `reaction.received`, `comment.received`,
  `conversation.started`, `call.*`, or `review.*` requires inbox access
  (`FEATURE_NOT_AVAILABLE` otherwise).
- Subscribing to `ad.status_changed` requires the ads add-on
  (`ADS_ADDON_REQUIRED` otherwise).
- A restricted (`zrk_`) API key cannot subscribe to events outside the resource
  groups it holds, and its own disabled groups are unioned into the
  subscription's `disabledResourceGroups`.
- The event list is validated against `WEBHOOK_EVENT_VALUES`, the flattened
  `event-catalog.ts` list; an unknown event name is a 400.

### The other endpoints

- `GET /v1/webhooks/settings?order=asc|desc` (default `desc`, newest first) →
  `{ webhooks: [...] }`, including each subscription's `secret`.
- `PUT /v1/webhooks/settings` with `{ _id, ...fields }`. Partial updates are
  allowed, but any field supplied must pass the create-time validation.
  Re-enabling a disabled webhook (`isActive: true` on an inactive one) resets
  `failureCount`, `firstFailureAt`, `disabledAt`, `disabledReason`.
- `DELETE /v1/webhooks/settings?id=<webhookId>`.
- `POST /v1/webhooks/test` with `{ webhookId }` sends a single `webhook.test`
  delivery with no retries. Returns 200 `{ success: true }` or, on a soft
  delivery failure, HTTP 500 `{ success: false, message: 'Test webhook failed' }`.
- `POST /v1/webhooks/logs/redeliver` with `{ webhookId, eventId }` replays the
  exact original payload (same `id`) to the subscription's current URL, as a
  single attempt. Payloads are retained 30 days; older replays fail. Returns 200
  on success, HTTP 502 `{ success: false }` when the endpoint errors again.
- `GET /v1/webhooks/logs` (plus `/logs/stats`, `/logs/facets`, `/logs/histogram`)
  for delivery history.

### Subscribable event names (`event-catalog.ts`)

Posts: `post.scheduled`, `post.published`, `post.failed`, `post.partial`,
`post.cancelled`, `post.recycled`, `post.platform.published`,
`post.platform.failed`, `post.platform.deleted`, `post.tiktok.url_resolved`.
External posts: `post.external.created`, `post.external.updated`,
`post.external.deleted`. Accounts: `account.connected`, `account.disconnected`,
`account.ads.initial_sync_completed`. Messages: `message.received`,
`message.sent`, `message.edited`, `message.deleted`, `message.delivered`,
`message.read`, `message.failed`, `reaction.received`. Conversations:
`conversation.started`. Calls: `call.received`, `call.ended`, `call.failed`,
`call.permission_request`. Comments: `comment.received`. Reviews: `review.new`,
`review.updated`. Ads: `ad.status_changed`, `lead.received`. WhatsApp:
`whatsapp.template.status_updated`, `whatsapp.number.activated`,
`whatsapp.number.declined`, `whatsapp.number.action_required`,
`whatsapp.automatic_event`, `whatsapp.number.verification_required`,
`whatsapp.number.suspended`, `whatsapp.number.reactivated`,
`whatsapp.number.released`, `whatsapp.number.kyc_submitted`. Verify:
`verification.approved`, `verification.failed`.

`webhook.test` is a real event name on the wire but is not in the catalog, so it
cannot be subscribed to; it is only produced by the test endpoint, which delivers
it regardless of the subscription's event list.

---

## Flagged ambiguities, collected

1. Retry ladder length: source comments say 28 h, 51 h, and "5 minutes for
   attempt 3", mutually inconsistent. The array in `retry-schedule.ts` is
   authoritative (about 51 h total).
2. `scheduledFor` / `publishedAt` are typed `string` in the projection but hold
   `Date` at runtime; they reach the wire as ISO-8601 via `JSON.stringify`.
3. The Node (test and redelivery) path signs the object and lets axios serialize
   it. That matches the worker byte-for-byte only because axios serializes plain
   objects with `JSON.stringify`. It is not asserted anywhere in the repo, only
   implied by axios behavior.
4. Delivery of a suppressed event (circuit open) is logged as `status: 'failed',
   statusCode: 0, attemptNumber: 0` in the customer's webhook log even though no
   HTTP request was made. A consumer reading the logs API should not read that
   row as an endpoint response.
5. `webhook.test` is delivered without checking the subscription's event list, so
   an endpoint can receive an event it never subscribed to.
