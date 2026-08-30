# Changelog

## 0.1.2

- Add the Convex components directory badge to the README.

## 0.1.1

No functional changes. Verifies the release path now that publishing runs
through npm trusted publishing (OIDC) with no token in CI.

## 0.1.0

Initial release.

- `Zernio` client class: `connectAccountUrl`, `syncAccounts`, `listAccounts`,
  `schedulePost`, `status`, `getPost`, `listPosts`, `cancelPost`, `request`,
  `api()` and `registerRoutes`.
- Durable post submission through a nested `@convex-dev/workpool`, with retries on
  408, 429, 5xx and network errors, and no retry on a permanent 4xx.
- Idempotent scheduling: a derived or caller-supplied key deduplicates in the
  component and is replayed to Zernio as `x-request-id`.
- `testMode`, defaulting to `true`, creates Zernio drafts so nothing publishes by
  accident while a developer is wiring the component up.
- Signed webhook route (`POST /zernio/webhook`) with constant-time HMAC-SHA256
  verification over the raw body, event-id deduplication and last-write-wins
  ordering, consuming `post.scheduled`, `post.published`, `post.failed`,
  `post.partial`, `post.cancelled`, `post.platform.published`,
  `post.platform.failed`, `account.connected` and `account.disconnected`.
- `onPostEvent` and `onAccountEvent` app mutations invoked in the same transaction
  as the component's own write.
- Single-tenant (`ZERNIO_PROFILE_ID`) and multi-tenant (`getUserInfo`) modes through
  the same methods, with Zernio profiles created on demand.
- Client-side rate limiting through `@convex-dev/rate-limiter`: 25 posts per hour
  per account, and 120 API calls per minute per profile.
- `request()` escape hatch for the rest of the Zernio API, and
  `verifyZernioSignature` exported for consumers with their own handlers.
- `useZernioPost` React hook in `@zernio/convex/react`.
