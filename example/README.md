# Zernio component example

A small Convex app that connects social accounts through Zernio, schedules a
post, and shows that post's status changing **live** as Zernio's webhooks land.
Nothing on the page polls: the component writes the webhook into its own table,
which invalidates the `status` query, which repaints the browser.

## What is in here

| file                      | what it shows                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `convex/convex.config.ts` | `app.use(zernio)`                                                                                                                           |
| `convex/example.ts`       | the client instance, the `onPostEvent` / `onAccountEvent` callbacks, the app-side function surface, and the multi-tenant shape in a comment |
| `convex/http.ts`          | `zernio.registerRoutes(http)`                                                                                                               |
| `convex/schema.ts`        | the app's own event log, written inside the component's webhook transaction                                                                 |
| `src/App.tsx`             | accounts, a compose box with a schedule-for control, and the live status pipeline                                                           |

## Setup

1. **Create a Zernio API key** at https://zernio.com with the `publishing` and
   `accounts` resource groups.

2. **Set the deployment environment variables.** These are read by the Convex
   backend, not by Vite, so use the dashboard or the CLI:

   ```sh
   npx convex env set ZERNIO_API_KEY late_sk_...
   # profiles[]._id from: curl -H "Authorization: Bearer $ZERNIO_API_KEY" \
   #   https://zernio.com/api/v1/profiles
   npx convex env set ZERNIO_PROFILE_ID <profile id>
   npx convex env set ZERNIO_WEBHOOK_SECRET whsec_...
   ```

   | variable                | required                  | used for                                                    |
   | ----------------------- | ------------------------- | ----------------------------------------------------------- |
   | `ZERNIO_API_KEY`        | yes                       | bearer auth on every Zernio call                            |
   | `ZERNIO_PROFILE_ID`     | yes in single-tenant mode | the profile every call runs against, reads included         |
   | `ZERNIO_WEBHOOK_SECRET` | yes                       | HMAC verification of incoming webhooks                      |
   | `ZERNIO_BASE_URL`       | no                        | override the API host, defaults to `https://zernio.com/api` |

   In multi-tenant mode (see `convex/example.ts`) `ZERNIO_PROFILE_ID` is unused:
   the component creates one Zernio profile per app user and keeps the mapping.

3. **Run it**, from the repo root:

   ```sh
   npm run dev            # Convex backend plus component build
   npm run dev:frontend   # Vite, in a second terminal
   ```

4. **Point a webhook at the deployment.** In the Zernio dashboard create a
   subscription with:

   - URL: `https://<your deployment>.convex.site/zernio/webhook` (the
     `.convex.site` host, not `.convex.cloud`)
   - Secret: the same value you set as `ZERNIO_WEBHOOK_SECRET`
   - Events: `post.scheduled`, `post.published`, `post.failed`, `post.partial`,
     `post.cancelled`, `post.platform.published`, `post.platform.failed`,
     `account.connected`, `account.disconnected`

   Without this the app still schedules posts, but the status panel stops at
   `scheduled`: the terminal status only ever arrives by webhook.

5. **Connect an account** in the UI (or connect one in the Zernio dashboard and
   press Sync), then write something and press Schedule post.

## Test mode is on by default

`testMode` defaults to **`true`**, so `schedulePost` creates the post as a
Zernio **draft**: it is stored, it is never queued, and it never reaches an
audience. The status pipeline settles on `draft` instead of `published`, and the
requested time is still stored so the UI can show what would have been
scheduled.

To publish for real, pass it explicitly in `convex/example.ts`:

```ts
export const zernio = new Zernio(components.zernio, {
  testMode: false,
  onPostEvent: internal.example.onPostEvent,
  onAccountEvent: internal.example.onAccountEvent,
});
```

Two things test mode does **not** cover:

- `zernio.request(...)`, the escape hatch, is raw by design. A `POST /v1/posts`
  with `publishNow: true` through it publishes for real even while `testMode` is
  `true`.
- Connecting and syncing accounts always hits the real Zernio API.

## Reading the live panel

The pipeline lists the states a post passes through and, on the right of each
row, where that state came from:

| step                                     | source                                      |
| ---------------------------------------- | ------------------------------------------- |
| Queued locally                           | the component mutation, in your transaction |
| Submitting to Zernio                     | the workpool job, retried with backoff      |
| Scheduled at Zernio                      | the `POST /v1/posts` response               |
| Published / Failed / Partial / Cancelled | a webhook                                   |

The Webhook stream below it is the app's own `postEventLog` table, written by
the `onPostEvent` callback **inside** the component's webhook transaction. A row
there exists if and only if the component applied that event, and a replayed
delivery adds nothing because the component dedupes on the event id.
