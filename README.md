# Convex Zernio Component

[![npm version](https://badge.fury.io/js/@zernio%2Fconvex.svg)](https://badge.fury.io/js/@zernio%2Fconvex)

<!-- START: Include on https://convex.dev/components -->

Schedule and publish social media posts from your Convex app with [Zernio](https://zernio.com):
one durable call per post, per-platform status that lands in your database by webhook, and a
typed escape hatch to the rest of Zernio's API.

```ts
// convex/zernio.ts
import { Zernio } from "@zernio/convex";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation } from "./_generated/server";

export const zernio = new Zernio(components.zernio);

export const announceLaunch = mutation({
  args: { accountIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const { postId } = await zernio.schedulePost(ctx, {
      accountIds: args.accountIds,
      content: "We just shipped. The whole story is on the blog.",
      mediaUrls: ["https://example.com/launch.jpg"],
      scheduledFor: Date.now() + 60 * 60 * 1000,
    });
    return postId;
  },
});
```

That call returns immediately. Submission to Zernio runs in a durable
[workpool](https://www.npmjs.com/package/@convex-dev/workpool) with retries and rate limiting,
and the post's status is kept fresh from Zernio's webhooks, so
`zernio.status(ctx, postId)` is a reactive query your UI can subscribe to.

**By default nothing is published.** `testMode` defaults to `true`, which creates the post in
Zernio as a **draft**. See [Test mode](#test-mode-the-safety-rail) for the one line you flip
when you are ready to publish for real.

Found a bug? Feature request?
[File it here](https://github.com/zernio-dev/convex-zernio/issues).

## Prerequisites

### A Zernio account and API key

Create an API key in the [Zernio dashboard](https://zernio.com). Restricted keys (prefixed
`zrk_`) carry a set of resource groups; the key you give this component needs:

| Resource group | Needed for |
| --- | --- |
| `publishing` | `/v1/posts/**`, so `schedulePost` and `cancelPost` |
| `accounts` | `/v1/accounts/**`, `/v1/profiles/**` and `/v1/connect/**`, so `syncAccounts` and `connectAccountUrl` |
| `webhooks` | only if you manage webhook subscriptions with the same key through `request()` instead of the dashboard |

A legacy full-access key (no denylist) already has all of them. Subscribing to an event family
also requires that family's own group, so a key without `publishing` cannot subscribe to
`post.*`.

### A Convex app

You will need a Convex project. Start with the
[Convex quickstart](https://docs.convex.dev/home) if you do not have one.

## Installation

```sh
npm install @zernio/convex
```

Register the component in `convex/convex.config.ts`:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import zernio from "@zernio/convex/convex.config.js";

const app = defineApp();
app.use(zernio);

export default app;
```

**Single-tenant apps need a Zernio profile id.** A profile is Zernio's tenancy unit, and the
OAuth connect flow requires one. List yours and take `profiles[]._id`:

```sh
curl -H "Authorization: Bearer $ZERNIO_API_KEY" https://zernio.com/api/v1/profiles
# {"profiles":[{"_id":"6507a1b2c3d4e5f6a7b8c9d0","name":"Acme", ...}]}
```

Multi-tenant apps skip this: the component creates one Zernio profile per app user on the user's
first `connectAccountUrl` or `syncAccounts`, so `ZERNIO_PROFILE_ID` stays unset.

Set the environment variables on your deployment:

```sh
npx convex env set ZERNIO_API_KEY "zrk_..."
npx convex env set ZERNIO_WEBHOOK_SECRET "a long random string you choose"
# Single-tenant apps only (see Tenancy below):
npx convex env set ZERNIO_PROFILE_ID "6507a1b2c3d4e5f6a7b8c9d0"
# Optional, to point at a local Zernio: defaults to https://zernio.com/api
npx convex env set ZERNIO_BASE_URL "http://localhost:3000/api"
```

| Variable | Used for | Option that overrides it |
| --- | --- | --- |
| `ZERNIO_API_KEY` | bearer auth on every call | `options.apiKey` |
| `ZERNIO_WEBHOOK_SECRET` | HMAC verification of incoming webhooks | `options.webhookSecret` |
| `ZERNIO_PROFILE_ID` | the profile used in single-tenant mode | `options.profileId` |
| `ZERNIO_BASE_URL` | API host override | `options.baseUrl` |

All four are read from `process.env` on **every call**, never cached in the constructor.

Instantiate the client:

```ts
// convex/zernio.ts
import { Zernio } from "@zernio/convex";
// `internal` is only needed once you wire the optional event callbacks below.
import { components } from "./_generated/api";

export const zernio = new Zernio(components.zernio, {
  // Multi-tenant: one Zernio profile per app user. Omit to run single-tenant.
  getUserInfo: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) throw new Error("Not signed in");
    return { userId: identity.subject, email: identity.email };
  },
  // Optional: run your own mutation in the same transaction as the component's write.
  // Uncomment once you have defined them, see "Reacting to events in your own tables".
  // onPostEvent: internal.zernio.onPostEvent,
  // onAccountEvent: internal.zernio.onAccountEvent,
  // testMode defaults to TRUE. Everything is a draft until you set this to false.
  testMode: true,
});
```

Mount the webhook route in `convex/http.ts`:

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { zernio } from "./zernio";

const http = httpRouter();

// Mounts POST /zernio/webhook. Change the path with options.httpPrefix.
zernio.registerRoutes(http);

export default http;
```

### Configure the webhook on the Zernio side

Point a Zernio webhook subscription at your Convex **site** URL (`.convex.site`, not
`.convex.cloud`) and give it the same secret you set as `ZERNIO_WEBHOOK_SECRET`. Zernio does
not generate the secret; you choose it, and a subscription created without one sends no
signature headers at all, which this component rejects.

```sh
curl -X POST https://zernio.com/api/v1/webhooks/settings \
  -H "Authorization: Bearer $ZERNIO_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Convex",
    "url": "https://YOUR_DEPLOYMENT.convex.site/zernio/webhook",
    "secret": "the same value as ZERNIO_WEBHOOK_SECRET",
    "events": [
      "post.scheduled",
      "post.published",
      "post.failed",
      "post.partial",
      "post.cancelled",
      "post.platform.published",
      "post.platform.failed",
      "account.connected",
      "account.disconnected"
    ]
  }'
```

Those nine events are exactly the ones the component consumes. Any other event is answered
`200` and ignored, so subscribing to more is harmless but pointless.

## Tenancy

Zernio's tenancy unit is the **profile**, and the OAuth connect flow requires one. The
component supports both shapes through the same methods.

**Single-tenant.** Omit `getUserInfo`. Every call uses `options.profileId ?? process.env.ZERNIO_PROFILE_ID`.
No user model needed.

```ts
export const zernio = new Zernio(components.zernio); // profile from ZERNIO_PROFILE_ID
```

**Multi-tenant.** Supply `getUserInfo(ctx)` returning `{ userId, email? }`. The component keeps
a table mapping your `userId` to a Zernio profile id, creating the Zernio profile on the first
`connectAccountUrl` or `syncAccounts` call (with an `Idempotency-Key`, so a retry never makes a
second profile). `email` is used as the profile name when it creates one.

An explicit `userId` argument always wins, in either mode, so a cron or a server-to-server
action can act for one user without `ctx.auth`:

```ts
await zernio.syncAccounts(ctx, { userId: "user_123" });
```

## Connecting accounts

Send the user through Zernio's OAuth flow, then pull the result into the component's table.

```ts
// convex/zernio.ts
export const startConnect = action({
  args: { platform: v.string() },
  handler: async (ctx, args) => {
    const { authUrl } = await zernio.connectAccountUrl(ctx, {
      platform: args.platform, // instagram, tiktok, linkedin, twitter, youtube, ...
      redirectUrl: "https://yourapp.com/settings/social",
    });
    return authUrl; // redirect the browser here
  },
});
```

Redirect the user to `authUrl`. When they come back, refresh the local table:

```ts
export const finishConnect = action({
  args: {},
  handler: async (ctx) => await zernio.syncAccounts(ctx),
});
```

`syncAccounts` is safe as the very first call: it creates the profile if there is none. It
never deletes rows, so an account that disappears from Zernio is marked `isActive: false` and
old posts still resolve their target. If you subscribed to `account.connected`, the account
also appears by webhook without a sync.

Read accounts reactively (this is a plain database query, no HTTP):

```ts
export const accounts = query({
  args: {},
  handler: async (ctx) => await zernio.listAccounts(ctx, { platform: "instagram" }),
});
```

Each row is `{ _id, zernioAccountId, zernioProfileId, platform, username, displayName?, avatarUrl?, isActive, syncedAt }`.
Pass `zernioAccountId` values (not the component's `_id`) to `schedulePost`.

## Scheduling posts

```ts
const { postId, status, duplicate } = await zernio.schedulePost(ctx, {
  accountIds: ["6507a1b2c3d4e5f6a7b8c9d0", "6507a1b2c3d4e5f6a7b8c9d1"],
  content: "Shipping notes for this week.",
  title: "Weekly notes",              // used by platforms that take one, e.g. YouTube
  mediaUrls: ["https://cdn.example.com/clip.mp4"],
  scheduledFor: Date.now() + 3600_000, // ms since epoch, UTC. Omit to publish now
  timezone: "Europe/Madrid",
  idempotencyKey: "weekly-notes-2026-w35", // optional, see below
});
```

- `scheduledFor` is a **number** (ms since epoch). Omitting it means publish immediately (or
  create a draft, in test mode).
- Every `accountId` must already exist in the component's table. If one does not, the call
  throws and tells you to run `syncAccounts` first. The component needs each account's platform
  because Zernio's create-post body takes `platforms: [{ platform, accountId }]`, never a bare
  list of account ids.
- **Idempotency.** `schedulePost` is safe to retry.
  - With no `idempotencyKey`, the component derives one from the profile, accounts, content,
    title, media, schedule and test mode. A repeat returns the original post with
    `duplicate: true` **while that post is still unresolved** (`pending`, `submitting`,
    `scheduled`) or was created in the last 10 minutes. A derived key means "this call is a
    retry", not "this content was ever posted": once the post has settled and that window has
    closed, the same content is schedulable again, and a cancelled post never blocks a new one.
  - With an explicit `idempotencyKey`, the key is the contract: it dedupes for as long as the row
    exists, whatever its status. Use it for "one post per invoice / per week / per job".
  - Keys are scoped to the profile, so tenants cannot collide on one.
  - The key also travels as `x-request-id`, which Zernio replays server-side where that feature
    is enabled. The component does not rely on it: before any retry would re-submit, it checks
    `GET /v1/posts` for the post a previous attempt may already have created and adopts it. So a
    retry cannot publish twice even when the server-side replay is off.

The call returns as soon as the row is written. Submission happens in the workpool: up to 5
attempts on 408, 429, 5xx and network errors, backing off 1m, 4m, 16m, 64m, so a post that hits
one of Zernio's escalating account cooldowns (10, 20, 40, 80 minutes) can still land. Permanent
4xx failures are not retried and mark the post `failed`.

### Checking status reactively

```ts
// convex/zernio.ts
export const postStatus = query({
  args: { postId: v.string() },
  handler: async (ctx, args) => await zernio.status(ctx, args.postId),
});
```

`status()` returns `null` for an id that is unknown, malformed, or owned by another tenant.
Otherwise:

```ts
{
  postId: string;
  status: "pending" | "submitting" | "draft" | "scheduled"
        | "published" | "partial" | "failed" | "cancelled";
  zernioPostId: string | null;
  scheduledFor: number | null;
  platforms: Array<{
    platform: string;
    accountId: string;
    status: "pending" | "processing" | "uploading" | "published" | "failed" | "cancelled";
    platformPostId?: string;
    publishedUrl?: string;
    errorMessage?: string;
    publishedAt?: number;
  }>;
  errorMessage: string | null;
  testMode: boolean;
  submittedAt: number | null;
  finalizedAt: number | null;
}
```

| Status | Meaning |
| --- | --- |
| `pending` | row created, submission queued |
| `submitting` | the create call is in flight, or Zernio accepted it asynchronously |
| `draft` | created as a Zernio draft (this is what test mode produces) |
| `scheduled` | Zernio has it queued, waiting for `scheduledFor` |
| `published` | every platform target published |
| `partial` | some targets published, at least one failed |
| `failed` | submission failed, or every target failed |
| `cancelled` | cancelled locally or in Zernio |

`getPost(ctx, postId)` returns the whole row (content, media, `accountIds`, `zernioPostId`,
timestamps) when you need more than the summary, with the same `null` rule. `listPosts(ctx, { status?, limit? })`
returns the caller's posts newest first, 50 by default.

`status`, `getPost` and `cancelPost` are scoped to the caller's tenant, like `listPosts`: a post
id belonging to another profile reads as unknown and cannot be cancelled. In single-tenant mode
that tenant is `profileId` / `ZERNIO_PROFILE_ID`, so it has to be configured for these reads too.

There is a React hook for the common one-post view:

```tsx
import { useZernioPost } from "@zernio/convex/react";
import { api } from "../convex/_generated/api";

function PostBadge({ postId }: { postId: string }) {
  const { post, isLoading, isSettled, errorMessage } = useZernioPost(
    api.zernio.postStatus,
    postId,
  );
  if (isLoading) return <Spinner />;
  if (errorMessage) return <Error text={errorMessage} />;
  return <Badge status={post?.status} done={isSettled} />;
}
```

### Exposing the API to your frontend

In multi-tenant mode the whole public surface can be one destructuring. `zernio.api()` returns
the same functions already resolved through `getUserInfo`, and scoped to that user:

```ts
// convex/zernio.ts
export const {
  listAccounts,
  listPosts,
  getPost,
  status,
  schedulePost,
  cancelPost,
  connectAccountUrl,
  syncAccounts,
} = zernio.api();
```

```tsx
// the browser calls them directly
import { useZernioPost } from "@zernio/convex/react";
import { api } from "../convex/_generated/api";

const { post, isSettled } = useZernioPost(api.zernio.status, postId);
const schedule = useMutation(api.zernio.schedulePost);
```

None of them takes a `userId`: the caller is always `getUserInfo(ctx)`, and a post id belonging
to another user reads as unknown. `api()` throws without `getUserInfo`, because these functions
are reachable from a browser. A single-tenant app wraps the class methods in its own functions
instead (see `example/convex/example.ts`).

### Cancelling

```ts
const { status, cancelled } = await zernio.cancelPost(ctx, postId);
```

| Post status | What happens |
| --- | --- |
| `pending`, `submitting`, no Zernio post yet | the queued job is cancelled, no HTTP call |
| `submitting`, `draft`, `scheduled` with a `zernioPostId` | the queued job is cancelled **and** `DELETE /v1/posts/{id}` runs |
| `failed` | best-effort delete, then marked cancelled |
| `cancelled` | no-op, returns `cancelled: false` |
| `published`, `partial` | throws: it is already out there |

The delete runs whenever Zernio already holds the post, whatever the local status says: a
`submitting` row can already carry a post id (Zernio answered an idempotent replay with `202`),
and cancelling only the local job would let that post publish anyway.

Cancelling a post whose create call is already in flight cannot recall that call. The component
marks the row `cancelled`, and when the response lands it records the Zernio post id and deletes
that post from Zernio right away, so a cancelled post cannot publish. That delete is best effort:
if it fails the id is still on the row, and `DELETE /v1/posts/{id}` through
[`request()`](#the-escape-hatch) finishes the job. Removing a post that already published on a platform
is a different, destructive operation (`POST /v1/posts/{id}/unpublish`); do that deliberately
through [`request()`](#the-escape-hatch).

## Test mode, the safety rail

**`testMode` defaults to `true`.** While it is on, `schedulePost` creates the post in Zernio as
a **draft** (`isDraft: true`, with neither `scheduledFor` nor `publishNow`), so it is never
queued and never reaches an audience. You can build the whole flow, see real account ids, real
post ids and real drafts in the Zernio dashboard, without any risk of posting to a live account.

To publish for real, flip exactly one line:

```ts
export const zernio = new Zernio(components.zernio, {
  testMode: false, // posts now really publish
});
```

In test mode:

- the post lands on component status `draft`, never `scheduled` or `published`;
- the `scheduledFor` and `timezone` you asked for are still stored and returned, so your UI can
  show the intent;
- the per-account velocity rate limit is not consumed, matching Zernio skipping anti-abuse and
  quota checks for drafts;
- `testMode` is part of the derived idempotency key, so the same content submitted once as a
  test and once for real produces two distinct posts.

Test mode does **not** touch `connectAccountUrl`, `syncAccounts`, `listAccounts`, `cancelPost`
or webhook handling. And it deliberately does **not** rewrite `request()`: the escape hatch is
raw, so a `POST /v1/posts` with `publishNow: true` through `request()` publishes for real even
while `testMode` is `true`.

Promoting a draft to a real post is one `request()` call
(`PUT /v1/posts/{postId}` with `isDraft: false` plus a schedule); it is not a typed method.

## The escape hatch

Zernio's API is large (analytics, comments and DMs, ads, contacts, broadcasts, calls, reviews,
usage stats, webhook management, and more). This component deliberately owns only **posts and
accounts**, because those are the two surfaces with state that outlives the request: a post is
submitted now and resolves minutes or days later by webhook, and an account is connected once
and then used by every later post. Everything else is a plain request and response, and wrapping
it would add a second, worse copy of Zernio's own API.

So the rest of the surface is one typed call:

```ts
// convex/zernio.ts
export const webhookSubscriptions = action({
  args: {},
  handler: async (ctx) => {
    const { ok, status, data } = await zernio.request<{
      webhooks: Array<{
        _id: string;
        url: string;
        events: string[];
        isActive: boolean;
      }>;
    }>(ctx, {
      method: "GET",
      path: "/v1/webhooks/settings",
      query: { order: "desc" },
    });
    if (!ok) throw new Error(`Zernio ${status}: ${JSON.stringify(data)}`);
    return data.webhooks;
  },
});
```

You type the response; the component does not pretend to know Zernio's schemas.

Notes on `request()`:

- `path` must start with `/`, so the API key can never be sent to another host. It is joined to
  `baseUrl` (`https://zernio.com/api` by default), so you write `/v1/...`.
- A non-2xx does **not** throw. You get `{ ok: false, status, data }` with Zernio's error
  envelope (`{ error, type, code, param?, details? }`) intact.
- It consumes the same client-side API rate-limit budget as the component's own calls, keyed on
  the same tenant. A call made with neither auth nor a configured profile (a cron, say) shares one
  fallback bucket.
- It is an action, so call it from an action or `ctx.scheduler`, not from a mutation.

### If you want the rest of the API fully typed

`request()` is deliberately thin: you supply the response type. If you would rather have generated
types for every Zernio operation, install the official SDK alongside this component and use it
inside your own actions:

```sh
npm install @zernio/node
```

```ts
// convex/analytics.ts
"use node";
import { Zernio as ZernioApi } from "@zernio/node";

export const bestTime = action({
  args: { accountId: v.string() },
  handler: async (_ctx, args) => {
    const api = new ZernioApi({ apiKey: process.env.ZERNIO_API_KEY! });
    return await api.analytics.bestTime({ accountId: args.accountId });
  },
});
```

The SDK is generated from Zernio's OpenAPI spec, so it tracks the API automatically. It is not a
dependency of this component on purpose: bundling it would add its weight to every deployment that
installs this component, including the many that only ever schedule posts.

## Reacting to events in your own tables

`onPostEvent` and `onAccountEvent` are internal mutations that the component calls **inside the
same transaction** as its own write, so your table and the component's table can never disagree:

```ts
// convex/zernio.ts
export const onPostEvent = internalMutation({
  args: vPostEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.event === "post.published") {
      await ctx.db.insert("timeline", {
        zernioPostId: args.zernioPostId,
        urls: args.platforms.flatMap((p) => p.publishedUrl ?? []),
      });
    }
    return null;
  },
});
```

Import the arg validators so your handler stays in sync with the component:

```ts
import { vPostEventArgs, vAccountEventArgs } from "@zernio/convex";
```

Because the handler shares the transaction, a throw from it rolls back the component's write and
the deduplication record too, and Zernio retries the delivery. That is the intended behavior, and
the reason these handlers must be fast and must not call out to the network. Do slow work by
scheduling it from inside the handler.

## Webhook events consumed

| Event | What the component does | Resulting post status |
| --- | --- | --- |
| `post.scheduled` | replaces the per-platform state from the payload | `scheduled` |
| `post.published` | replaces per-platform state, stamps `finalizedAt` | `published` |
| `post.partial` | same, plus the first failing platform's error | `partial` |
| `post.failed` | same, plus the first failing platform's error | `failed` |
| `post.cancelled` | same, stamps `finalizedAt` | `cancelled` |
| `post.platform.published` | updates that one platform entry (`platformPostId`, `publishedUrl`, `publishedAt`) | adopted from the payload's post status, except `publishing`, which leaves the rollup alone |
| `post.platform.failed` | updates that one platform entry with its error | same rule |
| `account.connected` | upserts the account with `isActive: true` | not applicable |
| `account.disconnected` | upserts the account with `isActive: false` | not applicable |

Everything else in Zernio's catalog (`post.recycled`, `post.platform.deleted`,
`post.external.*`, `message.*`, `comment.received`, `ad.status_changed`, `webhook.test`, and the
rest) is answered `200` and ignored.

Delivery details the component already handles for you:

- The signature is verified in constant time against the **raw** request body.
- The event name and event id come from that signed body. The `X-Zernio-Event` /
  `X-Zernio-Event-Id` headers are unsigned copies, so they only fill in a body that lacks the
  field, and a header contradicting the body is rejected with `400`. Without that, one captured
  delivery could be replayed under new ids or relabelled as another event.
- Every event id is recorded, so a replay (including a manual redelivery, which reuses the
  original id) is a no-op.
- Zernio makes no ordering guarantee, so post-level writes are last-write-wins on the envelope's
  `timestamp`, and account writes use the same anchor: a redelivered `account.connected` cannot
  reactivate an account disconnected since. On top of that, a settled post never goes back to being
  in flight: nothing moves `published`, `partial`, `failed`, `draft` or `cancelled` back to
  `scheduled`. Zernio fires `post.scheduled` at create time, so it can arrive after your cancel.
  One settled state can still correct another, so a `post.published` that beat a cancel's delete
  is still recorded.
- Stored event bodies are dropped after 30 days, a bounded batch per delivery. The dedup rows
  themselves are kept forever (they are small), so replay safety never expires.

You can also verify deliveries yourself, in your own HTTP action:

```ts
import { verifyZernioSignature } from "@zernio/convex";

const ok = await verifyZernioSignature({ rawBody, signature, secret });
```

## Errors and rate limits

Client calls throw `ZernioError`, or `ZernioApiError` (with `status` and `code`) when Zernio
rejected the request:

```ts
import { isZernioApiError } from "@zernio/convex";

try {
  await zernio.schedulePost(ctx, args);
} catch (error) {
  if (isZernioApiError(error) && error.status === 402) {
    // free_tier_exceeded, enterprise_required, ...
  }
  throw error;
}
```

Two client-side rate limits guard the API key, both backed by
[@convex-dev/rate-limiter](https://www.npmjs.com/package/@convex-dev/rate-limiter):

- **25 posts per hour per account**, mirroring Zernio's documented velocity limit. The hour is
  the post's **intended publish hour**, not the moment you call `schedulePost`, so bulk-importing
  a month of content (one post per day) never trips it. Not consumed in test mode.
- **120 API calls per minute per profile**, burst 30, across every outbound call including
  `request()`. This is a conservative client-side guard, not a published Zernio number.

Hitting either surfaces as a `ZernioApiError` with `status: 429` and a retry hint.

## Reconciliation, and what this component does not do

There is no polling fallback. If your endpoint is down long enough, Zernio's circuit breaker
suppresses new events at enqueue time and they are **never** delivered, not even later, so a post
can sit at `scheduled` in the component's table forever. If that happens, backfill from the API
rather than from webhooks: a cron in your app that finds posts stuck in `scheduled` or
`submitting` past their `scheduledFor` and calls
``request({ method: "GET", path: `/v1/posts/${zernioPostId}` })`` is the supported path. A built-in
reconcile cron is out of scope for v1.

Also worth knowing:

- `zernio.api()` re-exports the typed surface for direct frontend use, and **requires**
  `options.getUserInfo`, because those functions are public and reachable from a browser. Every
  one of them resolves the caller through `getUserInfo` and is scoped to that user, so one tenant
  cannot read, schedule to, or cancel another tenant's posts and accounts. None of them accepts a
  `userId` argument.
- The API key travels inside the arguments of the queued submission job, so it is at rest in the
  workpool's tables for the lifetime of that job. It is never written to any of the component's
  own tables.
- Media is `mediaUrls: string[]`, mapped to Zernio's `mediaItems` with the type auto-detected
  from the extension. Richer media options (thumbnails, per-platform overrides) go through
  `request()`.

## API reference

```ts
new Zernio(components.zernio, options?)
```

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | `process.env.ZERNIO_API_KEY` | bearer key |
| `webhookSecret` | `process.env.ZERNIO_WEBHOOK_SECRET` | HMAC secret for incoming webhooks |
| `baseUrl` | `process.env.ZERNIO_BASE_URL`, then `https://zernio.com/api` | API host |
| `profileId` | `process.env.ZERNIO_PROFILE_ID` | single-tenant profile |
| `getUserInfo` | none | supplying it switches to multi-tenant mode |
| `onPostEvent` | none | internal mutation run in the component's transaction |
| `onAccountEvent` | none | internal mutation run in the component's transaction |
| `testMode` | **`true`** | create Zernio drafts instead of publishing |
| `httpPrefix` | `"/zernio"` | webhook route prefix |
| `maxParallelism` | `5` | concurrent post submissions |

| Method | Ctx | Returns |
| --- | --- | --- |
| `registerRoutes(http)` | n/a | mounts `POST <httpPrefix>/webhook` |
| `connectAccountUrl(ctx, { platform, redirectUrl?, userId? })` | action | `{ authUrl, state, profileId }` |
| `syncAccounts(ctx, { userId? })` | action | `ZernioAccount[]` |
| `listAccounts(ctx, { userId?, platform? })` | query | `ZernioAccount[]` |
| `schedulePost(ctx, { accountIds, content, scheduledFor?, title?, mediaUrls?, timezone?, idempotencyKey?, userId? })` | mutation | `{ postId, status, duplicate }` |
| `status(ctx, postId, { userId? })` | query | `ZernioPostStatusSummary \| null` |
| `getPost(ctx, postId, { userId? })` | query | `ZernioPost \| null` |
| `listPosts(ctx, { userId?, status?, limit? })` | query | `ZernioPost[]` |
| `cancelPost(ctx, postId, { userId? })` | action | `{ postId, status, cancelled }` |
| `request(ctx, { method, path, query?, body?, userId? })` | action | `{ status, ok, data }` |
| `api()` | n/a | the functions above, tenant-scoped, to re-export |

`state` from `connectAccountUrl` is opaque. Do not parse it.

## Troubleshooting

**Webhook returns 401 "Invalid signature".** The secret does not match. Zernio does not generate
the secret, you supply it at subscription time, so `ZERNIO_WEBHOOK_SECRET` must equal the
subscription's `secret` byte for byte. Read the stored value back with
`GET /v1/webhooks/settings`, which returns each subscription's secret. Also check the
subscription's `customHeaders`: they are merged last on delivery and can overwrite the signature
header.

**Webhook returns 500 "ZERNIO_WEBHOOK_SECRET is not configured".** Either the variable is unset
on the deployment (`npx convex env set ZERNIO_WEBHOOK_SECRET ...`), or the subscription was
created without a secret, in which case Zernio sends no signature header at all. Unsigned
deliveries are rejected on purpose: accepting them would make the route an open write endpoint.

**Webhooks never arrive.** Check, in order: the URL uses `.convex.site` and not `.convex.cloud`;
the path is `/zernio/webhook` (or your `httpPrefix`); `registerRoutes(http)` is called in
`convex/http.ts` and that file is deployed; the subscription lists the events you expect;
`GET /v1/webhooks/logs` shows attempts. Each attempt times out after 5 seconds, so a slow
`onPostEvent` handler can turn into a delivery failure. After about 2 hours of continuous
failure Zernio's circuit breaker suppresses new events permanently, and after 20 consecutive
terminal failures the subscription is disabled and must be re-enabled by hand, so fix the
endpoint and then backfill through `request()`.

**Cannot create or edit a subscription.** Webhook mutations refuse a profile-scoped API key with
`insufficient_permissions`, and a restricted key cannot subscribe to events outside the resource
groups it holds. Use an account-level key with `webhooks` plus `publishing` and `accounts`.

**An account does not appear in `listAccounts`.** `listAccounts` reads the component's table, not
Zernio, so call `syncAccounts` after connecting (or subscribe to `account.connected`). If it is
still missing: the account may belong to a different profile than the one this call resolves
(check `zernioProfileId` on the rows you do get), or it may sit outside your plan limit, since
`GET /v1/accounts` excludes over-limit profiles by default. Disconnected accounts are kept with
`isActive: false`, never deleted, so filter on `isActive` rather than assuming absence.

**`schedulePost` throws about an unknown account id.** Pass `zernioAccountId` values from
`listAccounts`, not the component's `_id` and not a platform's own user id, and run
`syncAccounts` first so the component knows each account's platform.

**A post is stuck at `scheduled` or `submitting`.** Nothing is wrong with the queue: those states
end when a webhook arrives. Check the webhook path above, then reconcile through
`GET /v1/posts/{zernioPostId}` with `request()`.

**Everything works but nothing is ever published.** That is `testMode`, which defaults to `true`.
Set `testMode: false`.

<!-- END: Include on https://convex.dev/components -->

## Development

```sh
npm install
npm run dev            # component build watcher plus the example app backend
npm run dev:frontend   # the example Vite app
```

Verify with:

```sh
npm run build:codegen && npm test && npm run lint
```

Tests run fully offline (`convex-test`, with `fetch` stubbed). See `SPEC.md` for the
implementation contract and `docs/contracts/` for the extracted Zernio HTTP contracts this
component was built against.
