# @zernio/convex implementation contract

This is the build contract for the component. Everything here is pinned: table shapes,
index names, function names, validators, signatures, state transitions. Where the extracted
HTTP contracts in `docs/contracts/` left something open, a choice is made and marked
**DECISION** so a reviewer can check it.

Ground truth for the API surface:

- `docs/contracts/posts.md`
- `docs/contracts/accounts.md`
- `docs/contracts/webhooks.md`

Conventions that apply everywhere:

- This Convex version uses table-name-first db calls: `ctx.db.get("posts", id)`,
  `ctx.db.patch("posts", id, {...})`, `ctx.db.insert("posts", {...})`.
- Every Convex function declares both `args` and `returns` validators.
- No em dashes in code comments or docs.
- Timestamps stored in component tables are **numbers** (ms since epoch, UTC).

---

## 0. Global decisions

**DECISION 0.1 (base URL).** The default `baseUrl` is `https://zernio.com/api`, taken from the
`servers` block of `public/openapi.yaml` (confirmed in `docs/contracts/accounts.md`). The task
brief said `https://getlate.dev/api`; the spec wins. `options.baseUrl` overrides. Trailing
slashes are stripped at resolve time. Paths are always joined as `${baseUrl}${path}` where
`path` starts with `/v1/`.

**DECISION 0.2 (where secrets live).** The component's Convex functions cannot read the app's
environment variables. The client class resolves `apiKey`, `webhookSecret`, `baseUrl` and
`profileId` from `options` or `process.env` **lazily, at each method call** (not in the
constructor, so tests can set env vars after construction) and passes what each component
function needs as an argument. `apiKey` and `webhookSecret` are **never** written to a
component table. The consequence to document in the README: `apiKey` does travel inside the
args of the enqueued workpool job, so it is at rest in the workpool component's tables for the
lifetime of that job.

**DECISION 0.3 (webhook route lives in the app, not the component).** `src/component/http.ts`
is **deleted**. `registerRoutes(http)` defines the route with `httpActionGeneric` in the app,
where `process.env` and the options closure are available. The handler verifies the signature
and then calls the component mutation `handleWebhookEvent` with an already-verified payload.
The example app's `convex.config.ts` therefore calls `app.use(zernio)` with no `httpPrefix`.

**DECISION 0.4 (scheduledFor is a number).** The public API takes `scheduledFor?: number`
(ms since epoch, UTC) only. It is serialized with `new Date(ms).toISOString()`, which ends in
`Z`, so per `docs/contracts/posts.md` Zernio ignores `timezone` for the scheduling
computation. `timezone` is still forwarded because it is stored on the post and used by queue
and platform-side semantics. Naive wall-clock strings are deliberately not accepted: they would
require a timezone library to round-trip into a component-stored number. A caller who needs
naive-plus-timezone semantics uses `request()`.

**DECISION 0.5 (nested components).** `src/component/convex.config.ts` becomes:

```ts
import { defineComponent } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config.js";
import rateLimiter from "@convex-dev/rate-limiter/convex.config.js";

const component = defineComponent("zernio");
component.use(workpool, { name: "postWorkpool" });
component.use(rateLimiter);

export default component;
```

`src/test.ts` must register the nested components, or every test that touches the workpool
fails:

```ts
import workpoolTest from "@convex-dev/workpool/test";
import rateLimiterTest from "@convex-dev/rate-limiter/test";

export function register(t, name = "zernio") {
  t.registerComponent(name, schema, modules);
  workpoolTest.register(t, `${name}/postWorkpool`);   // also registers `${name}/postWorkpool/batchWorker`
  rateLimiterTest.register(t, `${name}/rateLimiter`);
}
```

**DECISION 0.6 (file layout).**

```
src/component/convex.config.ts   nested components (above)
src/component/schema.ts          tables and indexes (section 1)
src/component/shared.ts          shared validators + pure helpers (no Convex functions)
src/component/zernio.ts          HTTP client for the Zernio REST API (pure fetch helpers)
src/component/lib.ts             every Convex function (section 2)
src/client/index.ts              Zernio class, registerRoutes, api() (section 3)
src/client/signature.ts          verifyZernioSignature (section 4)
src/test.ts                      component + nested component registration
```

---

## 1. Schema (`src/component/schema.ts`)

Shared validators live in `src/component/shared.ts` and are imported by both `schema.ts` and
`lib.ts`:

```ts
export const vPostStatus = v.union(
  v.literal("pending"),
  v.literal("submitting"),
  v.literal("draft"),
  v.literal("scheduled"),
  v.literal("published"),
  v.literal("partial"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const vPlatformStatus = v.union(
  v.literal("pending"),
  v.literal("processing"),
  v.literal("uploading"),
  v.literal("published"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const vPlatformTarget = v.object({
  platform: v.string(),
  accountId: v.string(),
  status: vPlatformStatus,
  platformPostId: v.optional(v.string()),
  publishedUrl: v.optional(v.string()),
  errorMessage: v.optional(v.string()),
  publishedAt: v.optional(v.number()),
});

export const vRuntimeOptions = v.object({
  baseUrl: v.string(),
  testMode: v.boolean(),
  onPostEvent: v.optional(v.string()),     // FunctionHandle string
  onAccountEvent: v.optional(v.string()),  // FunctionHandle string
});
```

`vPlatformStatus` is the Zernio model enum from `docs/contracts/posts.md` discrepancy 7
(`pending, processing, published, failed, cancelled, uploading`), not the looser spec prose.

### 1.1 `profiles`

```ts
profiles: defineTable({
  userId: v.string(),
  zernioProfileId: v.string(),
})
  .index("by_userId", ["userId"])
  .index("by_zernioProfileId", ["zernioProfileId"]),
```

One row per app user in multi-tenant mode. Single-tenant mode never writes this table.

### 1.2 `accounts`

```ts
accounts: defineTable({
  zernioAccountId: v.string(),
  zernioProfileId: v.string(),
  platform: v.string(),
  username: v.string(),
  displayName: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
  isActive: v.boolean(),
  syncedAt: v.number(),
  lastEventAt: v.optional(v.number()),
})
  .index("by_zernioAccountId", ["zernioAccountId"])
  .index("by_profile", ["zernioProfileId", "platform"]),
```

- `zernioAccountId` is Zernio's `SocialAccount._id` (`docs/contracts/accounts.md`: the id field
  is `_id`, there is no `id`).
- `avatarUrl` maps from `SocialAccount.profilePicture`, which is nullable; a `null` is stored as
  an absent key, never as `null`.
- **DECISION 1.2a.** `username` is required by this schema but optional in Zernio's
  `SocialAccount` (`required: [_id, platform, profileId, isActive]`). An absent username is
  stored as the empty string. Consumers filter on `isActive`, never on a truthy username.
- **DECISION 1.2b.** `by_profile` is `["zernioProfileId", "platform"]` so `listAccounts` can
  filter by platform on the index instead of post-filtering.
- **DECISION 1.2c.** `profileId` on a Zernio account is polymorphic (raw id string or embedded
  `Profile` object, `docs/contracts/accounts.md` ambiguity 3). Normalize at the boundary:
  `typeof profileId === "string" ? profileId : profileId._id`.
- **DECISION 1.2d (`lastEventAt` added).** The newest account webhook envelope `timestamp`
  already applied, as ms. Delivery is at-least-once and unordered, so without it a redelivered
  `account.connected` reactivates an account the user has since disconnected. Deliberately not
  `syncedAt`, which runs off the sync clock and would make the comparison meaningless.

### 1.3 `posts`

```ts
posts: defineTable({
  zernioPostId: v.optional(v.string()),
  zernioProfileId: v.string(),
  status: vPostStatus,
  content: v.string(),
  title: v.optional(v.string()),
  mediaUrls: v.optional(v.array(v.string())),
  scheduledFor: v.optional(v.number()),
  timezone: v.optional(v.string()),
  accountIds: v.array(v.string()),
  platforms: v.array(vPlatformTarget),
  idempotencyKey: v.string(),
  testMode: v.boolean(),
  errorMessage: v.optional(v.string()),
  submittedAt: v.optional(v.number()),
  finalizedAt: v.optional(v.number()),
  workId: v.optional(v.string()),
  submitAttempts: v.optional(v.number()),
  lastEventAt: v.optional(v.number()),
})
  .index("by_zernioPostId", ["zernioPostId"])
  .index("by_profile_idempotencyKey", ["zernioProfileId", "idempotencyKey"])
  .index("by_profile_creation", ["zernioProfileId"])
  .index("by_profile_status", ["zernioProfileId", "status"]),
```

- **DECISION 1.3a (`workId` added).** Not in the brief's field list. Needed so `cancelPost` can
  cancel a workpool job that has not started yet. Holds the `WorkId` returned by
  `postWorkpool.enqueueAction`.
- **DECISION 1.3b (`lastEventAt` added).** Not in the brief's field list. Holds the ISO
  `timestamp` of the newest post-level webhook envelope already applied, as ms. Webhook delivery
  has no ordering guarantee (`docs/contracts/webhooks.md` section 4), and the recommended
  reconciliation is last-write-wins on `timestamp`. Without this field an out-of-order
  `post.scheduled` retried hours later would overwrite a `published` post.
- **DECISION 1.3c (`submitAttempts` added).** How many times the submit job has run. Any attempt
  past the first reconciles against Zernio before it would POST again: Zernio's `x-request-id`
  replay is behind a rollout flag (`PUBLISH_CLAIMS_ENABLED`, default off), so it cannot be the
  only thing between a workpool retry and a second live post.
- **DECISION 1.3d (idempotency index is per profile).** `by_profile_idempotencyKey`, never a bare
  `by_idempotencyKey`: `schedulePost` accepts a caller-supplied key and is reachable from the
  browser through `api()`, so a global key space would let one tenant claim another tenant's key
  and be handed that tenant's `postId`.
- **DECISION 1.3e (`by_profile_creation`).** `by_profile_status` descends
  `(zernioProfileId, status, _creationTime)`, so an unfiltered `listPosts` on it orders by status
  name, not recency. The unfiltered path uses `by_profile_creation`.
- `accountIds` is the caller's input list; `platforms` is the resolved per-target state. Both are
  kept: `accountIds` records intent even when an account row is later deactivated.

### 1.4 `postEvents`

```ts
postEvents: defineTable({
  postId: v.optional(v.id("posts")),
  zernioPostId: v.optional(v.string()),
  event: v.string(),
  platform: v.optional(v.string()),
  eventId: v.string(),
  receivedAt: v.number(),
  payload: v.optional(v.any()),
})
  .index("by_postId", ["postId"])
  .index("by_eventId", ["eventId"])
  .index("by_receivedAt", ["receivedAt"]),
```

- **DECISION 1.4a.** `postId` and `zernioPostId` are **optional** so this one table is the dedupe
  log for every consumed webhook event, including `account.connected` /
  `account.disconnected` (no post) and post events for a `zernioPostId` this component never
  created (no local row). The brief listed them as required; making them optional avoids adding
  a second table while keeping `by_eventId` the single replay guard.
- `by_eventId` is what makes replay a no-op: `eventId` is the webhook envelope's `id`, which
  Zernio deliberately reuses on manual redelivery.
- **DECISION 1.4b (payload retention).** `payload` is optional because each incoming delivery
  clears the stored body of up to 10 rows older than 30 days (`by_receivedAt`, cursored by the
  `maintenance` row). The rows themselves are never deleted: `by_eventId` is the only replay
  guard, so deleting them would let a late redelivery apply twice.

### 1.5 `lastOptions`

```ts
lastOptions: defineTable({
  options: vRuntimeOptions,
}),
```

No index. At most one row (the resend pattern). Written by `setOptions` from every public
component function that receives options; read by `handleWebhookEvent` when the caller passed
none. Contains no secrets (DECISION 0.2).

### 1.6 `maintenance`

```ts
maintenance: defineTable({
  prunedThrough: v.number(),
}),
```

At most one row. The cursor of the payload prune, so a delivery never rescans what it already
cleared, which is what keeps the prune O(batch) instead of O(table). Written only when a delivery
actually pruned something: writing it on every delivery would make this single row a contention
point for no gain.

---

## 2. Component functions (`src/component/lib.ts`)

Doc validators, the template idiom:

```ts
const vPostDoc = schema.tables.posts.validator.extend({
  _id: v.id("posts"),
  _creationTime: v.number(),
});
const vAccountDoc = schema.tables.accounts.validator.extend({
  _id: v.id("accounts"),
  _creationTime: v.number(),
});
const vPostStatusSummary = v.object({
  postId: v.id("posts"),
  status: vPostStatus,
  zernioPostId: v.union(v.null(), v.string()),
  scheduledFor: v.union(v.null(), v.number()),
  platforms: v.array(vPlatformTarget),
  errorMessage: v.union(v.null(), v.string()),
  testMode: v.boolean(),
  submittedAt: v.union(v.null(), v.number()),
  finalizedAt: v.union(v.null(), v.number()),
});
```

Instances created once at module scope in `lib.ts`:

```ts
const postWorkpool = new Workpool(components.postWorkpool, { maxParallelism: 5 });
const rateLimiter = new RateLimiter(components.rateLimiter, {
  zernioApi:       { kind: "token bucket", rate: 120, period: MINUTE, capacity: 30 },
  postsPerAccount: { kind: "fixed window", rate: 25,  period: HOUR },
});
```

**DECISION 2.0a (`maxParallelism`).** The `Workpool` constructor options are read on each
`enqueue*` call, so the module-scope instance above is used for `cancel` and `status`, and
`schedulePost` builds its own instance inside the handler with
`new Workpool(components.postWorkpool, { maxParallelism: args.maxParallelism ?? 5 })`.
`vRuntimeOptions` therefore carries no `maxParallelism` field: it is a separate optional arg on
`schedulePost`, which the client fills from `options.maxParallelism`.

**DECISION 2.0b (rate limits).** `postsPerAccount` (25 per hour, keyed by `zernioAccountId`)
mirrors Zernio's documented velocity limit. `zernioApi` (120 per minute, burst 30, keyed by
`zernioProfileId`) is a conservative client-side guard, not a documented Zernio number. Every
outbound HTTP call consumes one `zernioApi` token. In test mode `postsPerAccount` tokens are
**not** consumed, because a draft skips Zernio's own anti-abuse and velocity checks
(`docs/contracts/posts.md`).

**DECISION 2.0c (errors).** Component functions throw
`new ConvexError({ kind: "zernio_api_error", status, code, message, param? })` for a Zernio
4xx, and `new NonRetryableError(...)` (from `@convex-dev/workpool`) inside `submitPost` for a
permanent 4xx so the workpool stops retrying. 429, 408, 5xx and network errors throw a plain
`Error` so the workpool retries.

### 2.1 Public functions (callable from the app)

| # | Name | Kind |
| --- | --- | --- |
| 1 | `schedulePost` | `mutation` |
| 2 | `getPost` | `query` |
| 3 | `getPostStatus` | `query` |
| 4 | `listPosts` | `query` |
| 5 | `listAccounts` | `query` |
| 6 | `connectUrl` | `action` |
| 7 | `syncAccounts` | `action` |
| 8 | `cancelPost` | `action` |
| 9 | `request` | `action` |
| 10 | `handleWebhookEvent` | `mutation` |

#### 1. `schedulePost` (mutation)

```ts
args: {
  options: vRuntimeOptions,
  apiKey: v.string(),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
  accountIds: v.array(v.string()),
  content: v.string(),
  title: v.optional(v.string()),
  mediaUrls: v.optional(v.array(v.string())),
  scheduledFor: v.optional(v.number()),
  timezone: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),
  maxParallelism: v.optional(v.number()),
}
returns: v.object({
  postId: v.id("posts"),
  status: vPostStatus,
  duplicate: v.boolean(),
})
```

Persists options, resolves the profile, enforces idempotency, resolves each `accountId` to its
platform from the `accounts` table **within the caller's profile**, inserts a `pending` post and
enqueues the workpool job. An `accountId` belonging to another profile is reported exactly like
an unknown one: the two must be indistinguishable, or the error is a cross-tenant account probe.
Full lifecycle in section 5.

#### 2. `getPost` (query)

```ts
args: {
  postId: v.string(),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
}
returns: v.union(v.null(), vPostDoc)
```

Returns the component's row verbatim. No HTTP.

**DECISION 2a (post reads are tenant-scoped).** `postId` is a plain string, normalized with
`ctx.db.normalizeId`, and the row is returned only when its `zernioProfileId` matches the profile
the caller resolves to. Unknown id, malformed id and another tenant's id are all `null`: these
functions are re-exported to the browser through `api()`, where authentication alone is not
authorization. A malformed id returning `null` also means a stale `/posts/:postId` route param
renders an empty state instead of throwing a validator error.

#### 3. `getPostStatus` (query)

```ts
args: {
  postId: v.string(),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
}
returns: v.union(v.null(), vPostStatusSummary)
```

Narrow projection for the common "where is my post" poll. Same scoping rule as `getPost`.

#### 4. `listPosts` (query)

```ts
args: {
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
  status: v.optional(vPostStatus),
  limit: v.optional(v.number()),
}
returns: v.array(vPostDoc)
```

Resolves `userId` to a profile via `profiles.by_userId` when `zernioProfileId` is absent, then
reads `by_profile_status` when a `status` is given and `by_profile_creation` otherwise, newest
first, `take(limit ?? 50)`. The two indexes exist because descending `by_profile_status` with the
status unbound orders by status name, not by recency (DECISION 1.3e).
**DECISION:** when neither `userId` nor `zernioProfileId` resolves to a profile, returns `[]`
rather than throwing, so an unauthenticated dashboard renders empty.

#### 5. `listAccounts` (query)

```ts
args: {
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
  platform: v.optional(v.string()),
}
returns: v.array(vAccountDoc)
```

Reads `accounts.by_profile`. No HTTP, so it is a real reactive query. Returns both active and
inactive rows; the caller filters. Returns `[]` when no profile resolves.

#### 6. `connectUrl` (action)

```ts
args: {
  options: vRuntimeOptions,
  apiKey: v.string(),
  platform: v.string(),
  redirectUrl: v.optional(v.string()),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
  profileName: v.optional(v.string()),
}
returns: v.object({
  authUrl: v.string(),
  state: v.string(),
  zernioProfileId: v.string(),
})
```

Resolves or creates the Zernio profile, then `GET /v1/connect/{platform}?profileId=...` with
`redirect_url` when given. Profile creation path (multi-tenant, no mapping yet):

- `POST /v1/profiles` with header `Idempotency-Key: zernio-convex-profile-${userId}` and body
  `{ name, description }`.
- **DECISION 6a.** `name = profileName ?? \`user:${userId}\``. The client passes the email from
  `getUserInfo` as `profileName`; that is the only use of `email`.
  `description = "Created by @zernio/convex for app user ${userId}"`.
- **DECISION 6b.** On `409 profile_name_conflict`, read `details.existingProfileId` and adopt it.
  If that key is missing, fall back to `GET /v1/profiles?name=<name>` and take the single match
  (the documented recovery path). If still ambiguous, throw.
- Then `upsertProfileMapping`. The mapping write is a separate internal mutation, so a crash
  between the HTTP call and the write leaves the `Idempotency-Key` to make the retry safe.

`state` is opaque and must not be parsed (`docs/contracts/accounts.md` ambiguity 10).

#### 7. `syncAccounts` (action)

```ts
args: {
  options: vRuntimeOptions,
  apiKey: v.string(),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
}
returns: v.array(vAccountDoc)
```

`GET /v1/accounts?profileId=<id>` (no pagination params: page and limit must be sent together
or the API 400s, and the unpaginated response is the full in-limit set). Maps each
`SocialAccount` and calls `upsertAccounts` with `deactivateMissing: true`. Returns the stored
rows. **DECISION 7a.** Accounts absent from the response are marked `isActive: false`, never
deleted, so historical posts still resolve their target account. **DECISION 7b.** A missing
profile mapping in multi-tenant mode is created here too, using the same path as `connectUrl`,
so `syncAccounts` is safe as a first call.

#### 8. `cancelPost` (action)

```ts
args: {
  options: vRuntimeOptions,
  apiKey: v.string(),
  postId: v.string(),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
}
returns: v.object({
  postId: v.id("posts"),
  status: vPostStatus,
  cancelled: v.boolean(),
})
```

Branching on the current status:

The post is resolved through `getPostInternal` with the same tenant scoping as `getPost`
(DECISION 2a): another tenant's id throws `zernio_post_not_found`, exactly like an unknown one.
Then, branching on the current status:

| current status | behavior |
| --- | --- |
| `pending`, `submitting` | `postWorkpool.cancel(ctx, workId)` when `workId` is set. `cancelled: true` |
| `draft`, `scheduled` | `DELETE /v1/posts/{zernioPostId}`. `cancelled: true` |
| `failed` | `DELETE /v1/posts/{zernioPostId}` best effort; a non-2xx is swallowed. `cancelled: true` |
| `published`, `partial` | throws `ConvexError({ kind: "zernio_cannot_cancel", ... })` |
| `cancelled` | no-op, `cancelled: false` |

Every branch ends in `markPostCancelled`. **DECISION 8c.** Cancelling the job and deleting in
Zernio are independent steps, not alternatives: a `submitting` row can already carry a
`zernioPostId` (the idempotent-replay 202 path records one and the job then completes), and
cancelling a finished job would leave Zernio publishing a post the app believes is cancelled. So
the delete runs whenever `zernioPostId` is set, whatever the status.

**DECISION 8a.** `cancelPost` never calls `POST /v1/posts/{id}/unpublish`. There is no cancel
endpoint (`docs/contracts/posts.md`); unpublish deletes the post from the platform and needs a
`platform` argument, which is a different, destructive operation. Removing a live post is done
through `request()`.

**DECISION 8b (cancel race).** Cancelling a `submitting` post cannot recall an in-flight
`POST /v1/posts`. The component marks the row `cancelled`; `recordSubmission` then sees the
`cancelled` status and **keeps** `cancelled` while still storing the returned `zernioPostId`,
and reports back that the row was cancelled so `submitPost` deletes the post it just created
(`deleteRacedPost`). A follow-up `cancelPost` cannot do this: a `cancelled` row is a no-op by
the table above, and leaving the delete to the caller would let the cancelled post publish at
its scheduled time. The delete is best effort; the id stays on the row so `request()` can retry
it. This is stated in the README.

#### 9. `request` (action, the escape hatch)

```ts
args: {
  options: vRuntimeOptions,
  apiKey: v.string(),
  method: v.union(
    v.literal("GET"), v.literal("POST"), v.literal("PUT"),
    v.literal("PATCH"), v.literal("DELETE"),
  ),
  path: v.string(),
  query: v.optional(v.record(v.string(), v.string())),
  body: v.optional(v.any()),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
}
returns: v.object({
  status: v.number(),
  ok: v.boolean(),
  data: v.any(),
})
```

Consumes one `zernioApi` token keyed on the caller's profile (or userId), like every other
outbound call, so one tenant's polling cannot drain another tenant's budget. **DECISION 9d.** The
client resolves that tenant best effort: a call with neither auth nor a configured profile still
works and shares one fallback bucket. Then issues the raw call against `${baseUrl}${path}` with the
bearer key. **DECISION 9a.** `path` must start with `/`; an absolute URL is rejected with a
`ConvexError`, so the key can never be sent to another host. **DECISION 9b.** A non-2xx does
**not** throw: it returns `{ ok: false, status, data }` so callers can read Zernio's error
envelope. **DECISION 9c.** `testMode` never rewrites `request()`. It is the raw escape hatch and
will publish for real if the caller tells it to. This is called out in the README next to the
test-mode section.

#### 10. `handleWebhookEvent` (mutation)

```ts
args: {
  options: v.optional(vRuntimeOptions),
  eventId: v.string(),
  event: v.string(),
  payload: v.any(),
  receivedAt: v.optional(v.number()),
}
returns: v.object({
  deduped: v.boolean(),
  applied: v.boolean(),
  postId: v.union(v.null(), v.id("posts")),
  accountId: v.union(v.null(), v.id("accounts")),
})
```

Called only by the app-side HTTP action, **after** signature verification. Options fall back to
the `lastOptions` row. Dedupe, state transition and callback all happen in this one mutation,
so the component write and the app's `onPostEvent` / `onAccountEvent` write commit together.
Mapping table in section 4.

### 2.2 Internal functions

| # | Name | Kind |
| --- | --- | --- |
| 11 | `submitPost` | `internalAction` |
| 12 | `onSubmitComplete` | `internalMutation` (via `postWorkpool.defineOnComplete`) |
| 13 | `markSubmitting` | `internalMutation` |
| 14 | `recordSubmission` | `internalMutation` |
| 15 | `recordSubmissionFailure` | `internalMutation` |
| 16 | `markPostCancelled` | `internalMutation` |
| 17 | `getPostInternal` | `internalQuery` |
| 18 | `setOptions` | `internalMutation` |
| 19 | `getOptions` | `internalQuery` |
| 20 | `getProfileIdForUser` | `internalQuery` |
| 21 | `upsertProfileMapping` | `internalMutation` |
| 22 | `upsertAccounts` | `internalMutation` |

#### 11. `submitPost` (internalAction)

```ts
args: {
  postId: v.id("posts"),
  options: vRuntimeOptions,
  apiKey: v.string(),
}
returns: v.object({
  zernioPostId: v.union(v.null(), v.string()),
  status: vPostStatus,
})
```

The workpool job: flips the row to `submitting`, reconciles first on any attempt past the first
(DECISION 11a), consumes a `zernioApi` token, `POST /v1/posts` with
`x-request-id: <idempotencyKey>`, then records the outcome. Body construction and response
handling in section 5.

**DECISION 11a (reconcile before re-POST).** A retry must never blind-POST. Zernio documents
`x-request-id` replay, but the implementation is gated on `PUBLISH_CLAIMS_ENABLED` (default
`false`) plus a rollout percentage, so with the flag off a retry of an attempt that already
reached Zernio creates a second real post. So: attempt 1 POSTs; every later attempt first runs
`GET /v1/posts?profileId=&limit=50&sortBy=created-desc` and adopts a post whose `content`,
account set and `createdAt` (within 5 minutes of `submittedAt`) match this row, unless another
local row already owns that id. A failed reconcile **throws** rather than falling through to a
POST: a duplicate publish is worse than a retry. A row that already carries a `zernioPostId`
returns immediately without any call.

#### 12. `onSubmitComplete` (internalMutation)

```ts
export const onSubmitComplete = postWorkpool.defineOnComplete({
  context: v.object({ postId: v.id("posts") }),
  handler: async (ctx, { context, result }) => { ... },
});
```

`result.kind === "success"` is a no-op (`submitPost` already wrote the state).
`result.kind === "failed"` patches the post to `status: "failed"`, `errorMessage: result.error`,
`finalizedAt: Date.now()`, unless the row is already `cancelled` or already terminal.
`result.kind === "canceled"` patches to `cancelled` unless already terminal.

#### 13. `markSubmitting` (internalMutation)

```ts
args: { postId: v.id("posts") }
returns: v.object({ proceed: v.boolean(), attempt: v.number() })
```

Sets `status: "submitting"`, increments `submitAttempts` and returns `{ proceed: true, attempt }`
only when the current status is `pending` or `submitting`. Any other status (a cancel landed
first, or a duplicate job) returns `{ proceed: false }` and writes nothing; `submitPost` then
returns without calling Zernio. `submittedAt` keeps the **first** attempt's instant, which is the
lower bound the reconcile of DECISION 11a searches from.

#### 14. `recordSubmission` (internalMutation)

```ts
args: {
  postId: v.id("posts"),
  zernioPostId: v.string(),
  status: vPostStatus,
  platforms: v.array(vPlatformTarget),
  errorMessage: v.optional(v.string()),
  finalized: v.boolean(),
}
returns: v.null()
```

Patches `zernioPostId`, `platforms`, `errorMessage`, and `status` (unless the row is already
`cancelled`, per DECISION 8b, in which case `zernioPostId` and `platforms` are still written).
Sets `finalizedAt: Date.now()` when `finalized` is true. Idempotent: re-running with the same
args is a no-op patch.

#### 15. `recordSubmissionFailure` (internalMutation)

```ts
args: { postId: v.id("posts"), errorMessage: v.string() }
returns: v.null()
```

Sets `status: "failed"`, `errorMessage`, `finalizedAt: Date.now()`. Used for a permanent 4xx
where no post was created. Skips when the row is already `cancelled`.

#### 16. `markPostCancelled` (internalMutation)

```ts
args: { postId: v.id("posts") }
returns: v.null()
```

Sets `status: "cancelled"`, `finalizedAt: Date.now()`, and sets every non-terminal entry in
`platforms` to `cancelled`.

#### 17. `getPostInternal` (internalQuery)

```ts
args: {
  postId: v.string(),
  userId: v.optional(v.string()),
  zernioProfileId: v.optional(v.string()),
}
returns: v.union(v.null(), vPostDoc)
```

Read used by `submitPost` and `cancelPost`, which are actions and cannot touch `ctx.db`. Applies
the scoping of DECISION 2a when a tenant is passed.

#### 17b. `getPostByZernioId` (internalQuery)

```ts
args: { zernioPostId: v.string() }
returns: v.union(v.null(), vPostDoc)
```

`posts.by_zernioPostId` lookup. Used before adopting a Zernio post id (the 409 dedup branch and
the reconcile of DECISION 11a): two local rows pointing at one Zernio post would send every later
webhook to only one of them, and cancelling either would delete the other's live post.

#### 18. `setOptions` (internalMutation)

```ts
args: { options: vRuntimeOptions }
returns: v.null()
```

Upserts the single `lastOptions` row (insert when the table is empty, patch otherwise).

#### 19. `getOptions` (internalQuery)

```ts
args: {}
returns: v.union(v.null(), vRuntimeOptions)
```

Reads the single `lastOptions` row.

#### 20. `getProfileIdForUser` (internalQuery)

```ts
args: { userId: v.string() }
returns: v.union(v.null(), v.string())
```

`profiles.by_userId` lookup, returning `zernioProfileId`.

#### 21. `upsertProfileMapping` (internalMutation)

```ts
args: { userId: v.string(), zernioProfileId: v.string() }
returns: v.string()
```

Inserts the mapping when absent and returns the stored `zernioProfileId`. When a row already
exists it returns the **existing** id and does not overwrite, so a racing double-create keeps
one stable profile per user.

#### 22. `upsertAccounts` (internalMutation)

```ts
args: {
  zernioProfileId: v.string(),
  accounts: v.array(v.object({
    zernioAccountId: v.string(),
    platform: v.string(),
    username: v.string(),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    isActive: v.boolean(),
  })),
  deactivateMissing: v.boolean(),
}
returns: v.array(vAccountDoc)
```

Upserts by `by_zernioAccountId`, stamping `syncedAt: Date.now()`. When `deactivateMissing` is
true, every row under `by_profile` for that profile that is absent from `accounts` is patched to
`isActive: false`. Returns all rows for the profile.

---

## 3. Client class (`src/client/index.ts`)

### 3.1 Ctx types

Follow the template's convention (minimum viable ctx), widened with optional `auth` because
`getUserInfo` needs it:

```ts
type RunQueryCtx    = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
type RunMutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
type RunActionCtx   = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;

export type QueryCtx    = RunQueryCtx    & { auth?: Auth };
export type MutationCtx = RunMutationCtx & { auth?: Auth };
export type ActionCtx   = RunActionCtx   & { auth?: Auth };
```

**DECISION 3.1a.** When a method needs a user and `options.getUserInfo` is set but `ctx.auth` is
absent, it throws `ZernioError("getUserInfo requires a ctx with auth")`. When `userId` is passed
explicitly it wins over `getUserInfo` and no auth is needed (server-to-server usage).

### 3.2 Options

```ts
export type ZernioOptions = {
  apiKey?: string;          // default process.env.ZERNIO_API_KEY
  webhookSecret?: string;   // default process.env.ZERNIO_WEBHOOK_SECRET
  baseUrl?: string;         // default process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api"
  profileId?: string;       // default process.env.ZERNIO_PROFILE_ID (single-tenant)
  getUserInfo?: (ctx: { auth: Auth }) => Promise<{ userId: string; email?: string }>;
  onPostEvent?: FunctionReference<"mutation", "internal", PostEventArgs>;
  onAccountEvent?: FunctionReference<"mutation", "internal", AccountEventArgs>;
  testMode?: boolean;       // default TRUE
  httpPrefix?: string;      // default "/zernio"
  maxParallelism?: number;  // default 5
};
```

Resolution rules:

- `apiKey`: `options.apiKey ?? process.env.ZERNIO_API_KEY`, read per call; throws
  `ZernioError("Missing Zernio API key")` when neither is set.
- **Tenancy mode is decided by `getUserInfo`.** Present means multi-tenant; absent means
  single-tenant, and every call uses `options.profileId ?? process.env.ZERNIO_PROFILE_ID`. A
  single-tenant call with no profileId throws
  `ZernioError("Missing profileId: set options.profileId or ZERNIO_PROFILE_ID")`.
- **DECISION 3.2a.** An explicit `userId` argument on a method always wins, in both modes. In
  single-tenant mode passing `userId` switches that one call to the multi-tenant path (a
  `profiles` mapping is used or created), which is what makes both modes work through the same
  methods.
- `onPostEvent` / `onAccountEvent` are turned into `FunctionHandle` strings with
  `createFunctionHandle(...)` at call time and travel inside `vRuntimeOptions`.

### 3.3 Exported types

```ts
export type ZernioPostStatus =
  | "pending" | "submitting" | "draft" | "scheduled"
  | "published" | "partial" | "failed" | "cancelled";

export type ZernioPlatformStatus =
  | "pending" | "processing" | "uploading" | "published" | "failed" | "cancelled";

export type ZernioPlatformTarget = {
  platform: string;
  accountId: string;
  status: ZernioPlatformStatus;
  platformPostId?: string;
  publishedUrl?: string;
  errorMessage?: string;
  publishedAt?: number;
};

export type ZernioAccount = { /* accounts doc, _id as string */ };
export type ZernioPost    = { /* posts doc, _id as string */ };
export type ZernioPostStatusSummary = { /* vPostStatusSummary, ids as strings */ };
```

### 3.4 Methods (pinned signatures)

```ts
export class Zernio {
  constructor(component: ComponentApi, options?: ZernioOptions);

  registerRoutes(http: HttpRouter): void;

  connectAccountUrl(
    ctx: ActionCtx,
    args: { platform: string; redirectUrl?: string; userId?: string },
  ): Promise<{ authUrl: string; state: string; profileId: string }>;

  syncAccounts(
    ctx: ActionCtx,
    args?: { userId?: string },
  ): Promise<ZernioAccount[]>;

  listAccounts(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    args?: { userId?: string; platform?: string },
  ): Promise<ZernioAccount[]>;

  schedulePost(
    ctx: MutationCtx | ActionCtx,
    args: {
      accountIds: string[];
      content: string;
      scheduledFor?: number;
      title?: string;
      mediaUrls?: string[];
      timezone?: string;
      idempotencyKey?: string;
      userId?: string;
    },
  ): Promise<{ postId: string; status: ZernioPostStatus; duplicate: boolean }>;

  status(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    postId: string,
    args?: { userId?: string },
  ): Promise<ZernioPostStatusSummary | null>;

  getPost(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    postId: string,
    args?: { userId?: string },
  ): Promise<ZernioPost | null>;

  listPosts(
    ctx: QueryCtx | MutationCtx | ActionCtx,
    args?: { userId?: string; status?: ZernioPostStatus; limit?: number },
  ): Promise<ZernioPost[]>;

  cancelPost(
    ctx: ActionCtx,
    postId: string,
    args?: { userId?: string },
  ): Promise<{ postId: string; status: ZernioPostStatus; cancelled: boolean }>;

  request<T = unknown>(
    ctx: ActionCtx,
    args: {
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      path: string;
      query?: Record<string, string>;
      body?: unknown;
      userId?: string;
    },
  ): Promise<{ status: number; ok: boolean; data: T }>;

  api(): {
    listAccounts: RegisteredQuery<"public", { platform?: string }, ZernioAccount[]>;
    listPosts:    RegisteredQuery<"public", { status?: ZernioPostStatus; limit?: number }, ZernioPost[]>;
    getPost:      RegisteredQuery<"public", { postId: string }, ZernioPost | null>;
    status:       RegisteredQuery<"public", { postId: string }, ZernioPostStatusSummary | null>;
    schedulePost: RegisteredMutation<"public", { accountIds: string[]; content: string; scheduledFor?: number; title?: string; mediaUrls?: string[]; timezone?: string; idempotencyKey?: string }, { postId: string; status: ZernioPostStatus; duplicate: boolean }>;
    cancelPost:   RegisteredAction<"public", { postId: string }, { postId: string; status: ZernioPostStatus; cancelled: boolean }>;
    connectAccountUrl: RegisteredAction<"public", { platform: string; redirectUrl?: string }, { authUrl: string; state: string; profileId: string }>;
    syncAccounts: RegisteredAction<"public", Record<string, never>, ZernioAccount[]>;
  };
}
```

Notes pinned per method:

- `schedulePost` takes `MutationCtx | ActionCtx` and never performs HTTP. In multi-tenant mode
  it needs an existing `profiles` mapping; when none exists it throws
  `ZernioError("No Zernio profile for user <id>. Call connectAccountUrl or syncAccounts first.")`.
  That is not a limitation in practice: a user with no mapping has no connected accounts.
- **DECISION 3.4a.** `schedulePost` throws when any `accountId` is missing from the `accounts`
  table, with a message telling the developer to call `syncAccounts` first. The component needs
  the platform for each account because `POST /v1/posts` takes
  `platforms: [{ platform, accountId }]`, never a bare `accountIds` array
  (`docs/contracts/posts.md`).
- `status`, `getPost`, `listPosts`, `listAccounts` accept any ctx that can `runQuery`, so they
  work inside a reactive query.
- **DECISION 3.4c.** `status`, `getPost` and `cancelPost` resolve the caller like every other
  method (`getUserInfo`, an explicit `userId`, or the single-tenant profile) and pass that tenant
  down, so a post id is only readable and cancellable by the tenant that owns it. Authentication
  is not authorization: without this, any signed-in user of a multi-tenant app could read another
  tenant's content from the browser, or cancel their scheduled post. A single-tenant app must
  therefore have `profileId` / `ZERNIO_PROFILE_ID` configured for these reads, which it needs for
  every other call anyway.
- **DECISION 3.4b.** `api()` requires `options.getUserInfo`; without it, `api()` throws
  immediately at call time. These functions are public and reachable from a browser, so the
  identity gate is mandatory. A single-tenant app either passes a `getUserInfo` that returns a
  constant `userId`, or wraps the class methods in its own authenticated functions.
- `api().*` functions never accept a `userId` argument. The user always comes from
  `getUserInfo(ctx)` and scopes the call, so `getPost`, `status` and `cancelPost` are
  tenant-scoped, not merely identity-gated.

### 3.5 `registerRoutes`

```ts
registerRoutes(http: HttpRouter): void
```

Mounts exactly one route:

```
POST  <httpPrefix>/webhook      default: POST /zernio/webhook
```

Handler, in order:

1. `const raw = await request.text()` (raw text, never a re-serialized object).
2. Read `X-Zernio-Signature`, falling back to `X-Late-Signature`; same for
   `X-Zernio-Event` / `X-Late-Event` and `X-Zernio-Event-Id` / `X-Late-Event-Id`.
3. **DECISION 3.5a.** No configured `webhookSecret` returns `500` with
   `{ error: "ZERNIO_WEBHOOK_SECRET is not configured" }` and processes nothing. Zernio omits
   the signature header entirely when the subscription has no secret
   (`docs/contracts/webhooks.md` section 1), so accepting unsigned deliveries would be an open
   write endpoint.
4. Missing signature header returns `401`. Signature mismatch returns `401`. Comparison uses the
   constant-time helper in section 4.
5. `JSON.parse(raw)` after verification; a parse failure returns `400`.
6. **DECISION 3.5c (the signed body is the source of truth).** `event = payload.event` and
   `eventId = payload.id`; the `X-Zernio-Event` / `X-Zernio-Event-Id` headers only fill in a body
   that lacks the field, and a header that **contradicts** the body returns `400`. The HMAC
   covers the body and nothing else, so both headers are unauthenticated copies: taking them
   first would let one captured delivery be replayed forever under attacker-chosen ids (the
   dedup key) and be relabelled as another event (the status transition). When both body and
   headers lack a field, `400`.
7. `ctx.runMutation(component.lib.handleWebhookEvent, { options, eventId, event, payload, receivedAt: Date.now() })`.
8. Return `200` with an empty body on success, on dedupe, and on an event the component does not
   consume. Any 2xx is a success to Zernio and the body is never interpreted, so an empty `200`
   is the correct reply.

**DECISION 3.5b.** Only `POST` is mounted. No `GET` health route, so the path cannot be probed
for existence differences.

---

## 4. Webhook verification and event mapping

### 4.1 `verifyZernioSignature` (`src/client/signature.ts`)

```ts
export async function verifyZernioSignature(args: {
  rawBody: string;
  signature: string;
  secret: string;
}): Promise<boolean>;
```

- HMAC-SHA256 over `rawBody` as UTF-8 bytes, key = `secret` as UTF-8 bytes, output lowercase
  hex, no prefix and no version tag, using Web Crypto (`crypto.subtle.importKey` + `sign`).
- Compares against `signature.trim().toLowerCase()` in **constant time**: return `false`
  immediately only on a length mismatch, otherwise XOR-accumulate over every char code and
  compare the accumulator to 0.
- The function is exported from the package so consumers can verify deliveries in their own
  handlers.

### 4.2 Ordering guard

Every consumed event carries `payload.timestamp` (ISO-8601). Let
`eventAt = Date.parse(payload.timestamp)` (falling back to `receivedAt` when unparseable).

A post-level write is applied only when `post.lastEventAt === undefined || eventAt >= post.lastEventAt`
**and** the transition is not a demotion. When applied, `lastEventAt` is set to `eventAt`. A
skipped event is still recorded in `postEvents` and still invokes `onPostEvent` (with the row's
unchanged status), so the app sees the delivery.

**DECISION 4.2a (settled is settled).** Timestamps alone do not protect a locally driven terminal
state, because a local write (a cancel) carries no envelope timestamp to compare against, and
stamping one from the Convex clock would make legitimate events skippable on clock skew between
Zernio and Convex. So a second guard: a transition out of a terminal status
(`draft`, `published`, `partial`, `failed`, `cancelled`) back into a non-terminal one is refused.
One terminal status may still correct another, so a `post.published` that beat a cancel's delete
still lands. Concretely, Zernio fires `post.scheduled`
immediately after `post.save()`, so it can arrive after the app cancelled the post and after the
component deleted it in Zernio; without this guard the row would read `scheduled` forever for a
post that no longer exists.

**DECISION 4.2b (account events get the same anchor).** `accounts.lastEventAt` holds the newest
applied account-event `timestamp`, and an `account.*` event older than it does not write
`isActive`. Delivery is at-least-once, so the retry of a 10:00 `account.connected` landing at
10:05 would otherwise reactivate an account disconnected at 10:02. The event is still recorded
and still invokes `onAccountEvent`.

### 4.3 `platforms` merge rule

The `post` block on every consumed post event is a **full projection read at fire time**
(`docs/contracts/webhooks.md`). So, subject to the ordering guard, `posts.platforms` is
**replaced wholesale** from `payload.post.platforms`, mapping:

| Zernio projection field | component field |
| --- | --- |
| `platform` | `platform` |
| `accountId` (may be absent on legacy entries) | `accountId`, falling back to the existing row's entry for the same platform, else `""` |
| `status` | `status` (one of the six `vPlatformStatus` values) |
| `platformPostId` | `platformPostId` |
| `publishedUrl` | `publishedUrl` |
| `error` | `errorMessage` |

On a `post.platform.*` event, the entry matching `platform.name` plus `account.accountId` is
then overwritten from the fresher top-level `platform` block (`status`, `platformPostId`,
`publishedUrl`, `error`), and `publishedAt` is set to `eventAt` for `post.platform.published`.

### 4.4 Event to state transition

Post lookup: `posts.by_zernioPostId` on `payload.post.id`. `postId: null` below means no local
row exists; the event is still deduped, recorded and forwarded to the callback.

| event | posts row change | resulting `posts.status` | `finalizedAt` |
| --- | --- | --- | --- |
| `post.scheduled` | platforms merge | `scheduled` | unchanged |
| `post.published` | platforms merge | `published` | set |
| `post.partial` | platforms merge, `errorMessage` = first failed platform's `error` | `partial` | set |
| `post.failed` | platforms merge, `errorMessage` = first failed platform's `error` | `failed` | set |
| `post.cancelled` | platforms merge | `cancelled` | set |
| `post.platform.published` | platforms merge + platform-block overwrite | adopted from `payload.post.status` via the mapping below, except `publishing` which maps to `submitting` and is **not** applied (the row keeps its status) | unchanged |
| `post.platform.failed` | platforms merge + platform-block overwrite, entry `errorMessage` = `platform.error` | same rule as above | unchanged |
| `account.connected` | upsert `accounts` by `zernioAccountId` with `isActive: true`, `syncedAt: now`, `lastEventAt: eventAt` | n/a | n/a |
| `account.disconnected` | upsert `accounts` with `isActive: false`, `syncedAt: now`, `lastEventAt: eventAt` | n/a | n/a |

Zernio post status to component status mapping (used when adopting `payload.post.status`):

| Zernio | component |
| --- | --- |
| `draft` | `draft` |
| `scheduled` | `scheduled` |
| `publishing` | `submitting` (not adopted from platform events, see above) |
| `published` | `published` |
| `partial` | `partial` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |

**DECISION 4.4a.** `post.recycled`, `post.platform.deleted`, `post.tiktok.url_resolved`,
`post.external.*`, `account.ads.initial_sync_completed`, `webhook.test` and every other catalog
event are **acknowledged with 200 and ignored**: no `postEvents` row, no state change, no
callback. The component consumes exactly the nine events named in the brief. Extending the set
is a schema-free change to one switch statement.

**DECISION 4.4b.** `account.connected` for a profile this component has never seen still inserts
the account row, using `payload.account.profileId` as `zernioProfileId`. A single-tenant
deployment sharing an API key across profiles therefore accumulates rows it did not sync; they
are filtered out by `by_profile` on read.

### 4.5 Dedupe

First statement in `handleWebhookEvent`: `postEvents.by_eventId` lookup on `eventId`. A hit
returns `{ deduped: true, applied: false, postId: <existing row's postId>, accountId: null }`
and writes nothing. Otherwise the row is inserted in the same transaction as the state change,
so a mutation retry cannot double-apply.

### 4.6 Callback payloads

`onPostEvent` is invoked with:

```ts
{
  eventId: string;
  event: "post.scheduled" | "post.published" | "post.failed" | "post.partial"
       | "post.cancelled" | "post.platform.published" | "post.platform.failed";
  postId: string | null;        // component posts._id as a string, null when unknown locally
  zernioPostId: string;
  status: ZernioPostStatus;     // the post status AFTER the transition
  platform: string | null;      // set only on post.platform.* events
  platforms: ZernioPlatformTarget[];
  errorMessage: string | null;
  receivedAt: number;
  payload: unknown;             // the verified envelope, verbatim
}
```

`onAccountEvent` is invoked with:

```ts
{
  eventId: string;
  event: "account.connected" | "account.disconnected";
  accountId: string;            // component accounts._id as a string
  zernioAccountId: string;
  zernioProfileId: string;
  platform: string;
  username: string;
  displayName: string | null;
  isActive: boolean;
  disconnectionType: "intentional" | "unintentional" | null;
  reason: string | null;
  receivedAt: number;
  payload: unknown;
}
```

**DECISION 4.6a.** Both are called with `await ctx.runMutation(handle, args)` **inside**
`handleWebhookEvent`, so the app's write and the component's write commit or roll back together
(the resend and twilio pattern). A throw from the app's handler therefore rolls back the
`postEvents` dedupe row too, and the delivery is retried by Zernio. This is intended and is
documented: handlers must be fast and must not call out to the network.

**DECISION 4.6b.** Component document ids are passed as plain `v.string()`, not `v.id(...)`,
because a component's ids are not valid ids in the app's data model.

---

## 5. `schedulePost` lifecycle

```
client.schedulePost(ctx, args)
  -> component mutation  lib.schedulePost      status: (row created) "pending"
  -> postWorkpool.enqueueAction(internal.lib.submitPost)
  -> workpool runs        lib.submitPost        status: "submitting"
  -> POST /v1/posts                             (x-request-id: idempotencyKey)
  -> lib.recordSubmission                       status: "draft" | "scheduled" | "published" | "partial" | "failed"
  -> webhook arrives      lib.handleWebhookEvent status: "published" | "partial" | "failed" | "cancelled"
```

### Step 1: `lib.schedulePost` (mutation, one transaction)

1. `setOptions(options)`.
2. Resolve the profile: `zernioProfileId` argument wins, else `getProfileIdForUser(userId)`, else
   throw.
3. **Idempotency point 1.** Compute the key when absent (DECISION 5a below), then look up the
   newest row on `posts.by_profile_idempotencyKey` for **this profile**. On a hit, return
   `{ postId, status, duplicate: true }` and write nothing. Convex mutations are serializable, so
   two concurrent identical calls cannot both miss. A hit on a *derived* key is qualified by
   DECISION 5e; an explicit caller key always dedupes.
4. Resolve every `accountId` through `accounts.by_zernioAccountId` into
   `{ platform, accountId, status: "pending" }`, rejecting an id whose row belongs to another
   profile exactly as if it were unknown (DECISION 3.4a).
5. Rate limit: when `options.testMode === false`, consume one `postsPerAccount` token per
   `accountId`, keyed `` `${accountId}:${hourOf(scheduledFor ?? now)}` `` (`throws: true`).
   Skipped in test mode (DECISION 2.0b). **DECISION 5f.** The bucket is the *intended publish
   hour*, not wall-clock now, because Zernio's velocity limit applies when the post publishes:
   keying on now would 429 a bulk import of a month of content, where only one post per hour ever
   publishes.
6. `ctx.db.insert("posts", { ... status: "pending", testMode: options.testMode, platforms, idempotencyKey, ... })`.
7. `const workId = await postWorkpool.enqueueAction(ctx, internal.lib.submitPost, { postId, options, apiKey }, { onComplete: internal.lib.onSubmitComplete, context: { postId }, retry: { maxAttempts: 5, initialBackoffMs: 1000, base: 2 } })`.
8. `ctx.db.patch("posts", postId, { workId })`.
9. Return `{ postId, status: "pending", duplicate: false }`.

**DECISION 5a (derived idempotency key).** When the caller omits `idempotencyKey`, the component
derives it synchronously as `"zc_" + fnv1a64hex(parts)` where `parts` is

```
`${zernioProfileId}|${[...accountIds].sort().join(",")}|${content}|${title ?? ""}|${(mediaUrls ?? []).join(",")}|${scheduledFor ?? "now"}|${testMode}`
```

FNV-1a 64-bit is used rather than SHA-256 because it is synchronous and a Convex mutation cannot
await `crypto.subtle`. Collision risk is negligible at this cardinality, and the failure mode
(a second identical post in the same profile being treated as a duplicate) matches Zernio's own
24 hour content-hash dedup. Callers who want two identical posts pass distinct
`idempotencyKey`s.

**DECISION 5e (a derived key means "this is a retry", not "this content was ever posted").** The
key carries no timestamp when `scheduledFor` is absent, so on its own it would make the same
publish-now content a permanent no-op: posting "Good morning!" tomorrow would silently return
yesterday's published row. A derived-key hit therefore only counts as a duplicate when the
existing row is still unresolved (`pending`, `submitting`, `scheduled`) or was created within the
last 10 minutes, and a `cancelled` row never blocks. An explicit caller-supplied key is
unqualified: that key is the caller's own contract.

### Step 2: `lib.submitPost` (workpool job)

1. `markSubmitting(postId)`; on `{ proceed: false }` return immediately with the current status.
   Status is now `submitting`.
2. `getPostInternal(postId)` for the row.
3. Consume one `zernioApi` token.
4. Build the body:

   ```jsonc
   {
     "content": "...",
     "title": "...",                       // omitted when absent
     "mediaItems": [{ "url": "..." }],     // omitted when mediaUrls is empty
     "platforms": [{ "platform": "...", "accountId": "..." }],
     "timezone": "UTC",                    // options-free, from args, default omitted
     // exactly one scheduling directive, see below
   }
   ```

   - **testMode true**: send `"isDraft": true` and send **neither** `scheduledFor` nor
     `publishNow`. The requested `scheduledFor` stays in the component row so the app can show
     the intent.
   - **testMode false with `scheduledFor`**: send `"scheduledFor": new Date(ms).toISOString()`.
   - **testMode false without `scheduledFor`**: send `"publishNow": true`.
     Sending nothing would silently auto-draft the post (`docs/contracts/posts.md`).
   - **DECISION 5b.** `mediaUrls` map to `mediaItems: [{ url }]` with no `type`; Zernio
     auto-detects the type from the extension. `mediaUrls` is the only media surface of the
     typed API; anything richer goes through `request()`.

5. **Idempotency point 2.** Header `x-request-id: <idempotencyKey>` on `POST /v1/posts`, so a
   workpool retry of a call that already reached Zernio replays instead of creating a second
   post (about a 5 minute window).
6. Response handling, following `docs/contracts/posts.md` (note the undocumented 200, 202 and
   207 are all reachable and a client treating "not 201" as failure is wrong):

   | status | action |
   | --- | --- |
   | 201, 200 | read `body.post` (never `existingPost`, which does not exist); `recordSubmission` with the mapped status and platforms |
   | 202 | `body.postId` only; `recordSubmission({ zernioPostId: body.postId, status: "submitting", platforms: unchanged, finalized: false })`; the webhook finalizes |
   | 207 | `body.post` plus a sibling `body.error`; `recordSubmission` with the mapped status (typically `partial`) and `errorMessage: body.error` |
   | 409 | content dedup. Adopt `body.details.existingPostId` with `recordSubmission({ status: "scheduled", finalized: false })` and **do not retry** (DECISION 5c: Zernio already holds an equivalent post). **DECISION 5h:** adopt only when no other local row owns that id; when one does, the row is marked `failed` with a message naming both posts and a `NonRetryableError` is thrown, because two rows aliasing one Zernio post would split its webhooks and let a cancel of either delete the other's live post |
   | 400, 401, 402, 403, 404, 422 | `NonRetryableError`; `onSubmitComplete` marks the post `failed` with the message from `body.error` |
   | 408, 429 | throw a plain `Error` so the workpool retries. When `Retry-After` is present, include it in the message |
   | 5xx, network, timeout | throw a plain `Error`; the workpool retries |

7. Status after `recordSubmission`, mapped from `body.post.status`:

   | situation | component status | `finalized` |
   | --- | --- | --- |
   | test mode (draft) | `draft` | true |
   | scheduled | `scheduled` | false |
   | immediate publish, all platforms ok | `published` | true |
   | immediate publish, some failed (207) | `partial` | true |
   | immediate publish, all failed | `failed` | true |
   | 202 in flight | `submitting` | false |

### Step 3: webhooks finalize

For a `scheduled` post the terminal status arrives by webhook only:
`post.published`, `post.partial`, `post.failed`, or `post.cancelled`, with the per-platform
detail filled in by `post.platform.published` / `post.platform.failed` (which fire **before**
the rollup but are not guaranteed to arrive first).

**DECISION 5d (no polling fallback).** The component does not poll `GET /v1/posts/{id}`. If the
webhook endpoint is down long enough, Zernio's circuit breaker permanently drops events
(`docs/contracts/webhooks.md` section 4), and a post can stay `scheduled` forever in the
component's table. The README states this and points at `request()` plus a cron in the app as
the reconciliation path. A built-in reconcile cron is explicitly out of scope for v1.

### Idempotency, all enforcement points

1. `posts.by_profile_idempotencyKey` in the `schedulePost` mutation. One Zernio post per key per
   profile, checked in a serializable transaction, qualified by DECISION 5e for derived keys.
2. The reconcile of DECISION 11a on every submit attempt past the first. This, not the
   `x-request-id` header, is what makes a workpool retry safe: the header's server-side support
   is behind a default-off flag.
3. `x-request-id: <idempotencyKey>` on `POST /v1/posts`. A second line of defence for the
   deployments where Zernio's publish claims are enabled (about a 5 minute window).
4. `postEvents.by_eventId` in `handleWebhookEvent`. Covers at-least-once delivery and deliberate
   manual redelivery, which replays the original `id`. The dedup row outlives its payload, which
   is pruned at 30 days.
5. `markSubmitting` returning `{ proceed: false }` for a post that is not `pending` or
   `submitting`, and `submitPost` returning early for a row that already carries a
   `zernioPostId`. Covers a duplicate or late workpool job.

---

## 6. Test mode, precisely

`options.testMode` defaults to **`true`**. The developer must set `testMode: false` explicitly
to publish for real.

What test mode does:

1. `POST /v1/posts` is sent with `"isDraft": true` and **without** `scheduledFor` and
   `publishNow`. Zernio stores the post with `status: "draft"`; it is never queued and never
   reaches an audience.
2. The component row lands on status `draft` with `finalizedAt` set. It never becomes
   `scheduled` or `published` from the submission path.
3. The requested `scheduledFor` and `timezone` are still stored on the component row and
   returned by `status()` and `getPost()`, so the app's UI shows what would have been scheduled.
4. `postsPerAccount` rate-limit tokens are not consumed, matching Zernio skipping anti-abuse,
   velocity and quota checks for drafts.
5. `testMode` participates in the derived idempotency key, so the same content submitted once in
   test mode and once for real produces two distinct posts.
6. Everything else is unchanged: real API key, real profile, real accounts, real HTTP, real
   webhooks. `post.scheduled` and friends simply never fire for a draft.

What test mode does **not** do:

- It does not affect `connectAccountUrl`, `syncAccounts`, `listAccounts`, `cancelPost` or
  `registerRoutes`.
- **It does not affect `request()`.** The escape hatch is raw by design; a `POST /v1/posts` with
  `publishNow: true` through `request()` publishes for real even when `testMode` is true. The
  README says this in the same section as the test-mode banner.

Promoting a test-mode draft to a real post is **not** a component method in v1
(**DECISION 6a**). The documented promotion is `PUT /v1/posts/{postId}` with `isDraft: false`
plus a schedule, which is one `request()` call; wiring it as a typed method would need a second
idempotency story and a status-transition path that no webhook confirms.

---

## 7. Environment variables

| name | used for | fallback |
| --- | --- | --- |
| `ZERNIO_API_KEY` | bearer auth on every call | `options.apiKey` |
| `ZERNIO_WEBHOOK_SECRET` | HMAC verification in `registerRoutes` | `options.webhookSecret` |
| `ZERNIO_PROFILE_ID` | single-tenant profile | `options.profileId` |
| `ZERNIO_BASE_URL` | override the API host (local dev) | `options.baseUrl`, then `https://zernio.com/api` |

All are read from `process.env` in the **client**, per call. The component never reads
`process.env`.

Required API key resource groups (`docs/contracts/accounts.md`): `publishing` for posts,
`accounts` for `/v1/accounts`, `/v1/profiles` and `/v1/connect`, plus `webhooks` if the app
manages subscriptions through `request()`.

---

## 8. Verification

```sh
cd convex-zernio && npm run build:codegen && npm test && npm run lint
```

Never run `convex dev`, `convex deploy` or anything needing a deployment. Tests use
`convex-test` and run offline; HTTP is stubbed by replacing `global.fetch`.
