# Zernio HTTP contract: accounts, profiles, OAuth connect

Source of truth: `public/openapi.yaml` in the Zernio monorepo (OpenAPI 3.1.0), plus
`docs/RESOURCE-GROUPS-PLAN.md` for the API-key resource groups. Everything below is
transcribed from those files. Anything not in them is called out under "Ambiguities and gaps".

## Base and auth

- Servers: `https://zernio.com/api` (production), `http://localhost:3000/api` (local).
  So the full URL for `GET /v1/accounts` is `https://zernio.com/api/v1/accounts`.
- Security scheme `bearerAuth`: HTTP bearer, the Zernio API key sent as `Authorization: Bearer <key>`.
- Secondary scheme `connectToken`: header `X-Connect-Token`, a short-lived (15 minute) token
  auto-generated when OAuth is initiated without a browser session. Used only by the
  platform-specific selection endpoints (for example Facebook page selection), not by the
  endpoints documented here.

## Shared schemas

### `Profile`

All properties optional in the schema (no `required` list).

| field | type | notes |
| --- | --- | --- |
| `_id` | string | profile id |
| `userId` | string | |
| `name` | string | |
| `description` | string | |
| `color` | string | e.g. `#ffeda0` |
| `isDefault` | boolean | |
| `isOverLimit` | boolean | present only when `includeOverLimit=true`; profile exceeds the plan limit |
| `createdAt` | string (date-time) | |

### `SocialAccount` (the account object)

`required: [_id, platform, profileId, isActive]`.

| field | type | notes |
| --- | --- | --- |
| `_id` | string | **the account id field. There is no `id`.** |
| `platform` | string enum | `tiktok, instagram, facebook, youtube, linkedin, twitter, threads, pinterest, reddit, bluesky, googlebusiness, telegram, snapchat, discord, slack, whatsapp, linkedinads, metaads, pinterestads, tiktokads, xads, googleads, openaiads` |
| `profileId` | `oneOf`: string OR embedded `Profile` | **polymorphic.** The `GET /v1/accounts` example shows it embedded as an object (`{_id, name, slug}`), so a consumer must handle both a raw id string and an object |
| `username` | string | |
| `displayName` | string | |
| `profilePicture` | `[string, "null"]` | may be null when the platform provides none |
| `profileUrl` | string | full public profile URL on the platform |
| `isActive` | boolean | required |
| `needsReconnection` | boolean | platform definitively reported the stored OAuth token dead. While true, `GET /v1/connect/{platform}/ads` returns a fresh `authUrl` (implicit `force=true`) instead of `alreadyConnected`. Cleared on re-authorization |
| `followersCount` | number | only present with the analytics add-on |
| `followersLastUpdated` | string (date-time) | only present with the analytics add-on |
| `parentAccountId` | `[string, "null"]` | parent posting account for ads accounts sharing its OAuth token; null for standalone ads and all posting accounts |
| `enabled` | boolean | false = created as a side effect (e.g. posting account auto-created when ads was connected first). Posting UI and scheduler ignore `enabled: false` accounts |
| `metadata` | object | platform-specific, fields vary. WhatsApp: `qualityRating`, `nameStatus`, `messagingLimitTier`, `verifiedName`, `displayPhoneNumber`, `wabaId`, `phoneNumberId`. LinkedIn: `profileData.bio`, `profileData.extraData.vanityName`, `organizationInfo.vanityName` |

Note the example under `GET /v1/accounts` includes a `slug` on the embedded profile
(`profileId: {_id, name, slug}`), but `slug` is **not** a property of the `Profile` schema.
Flagged below.

### `Pagination`

`{ page: integer, limit: integer, total: integer, pages: integer }`

### `ErrorResponse` (canonical error envelope)

| field | type | notes |
| --- | --- | --- |
| `error` | string | human-readable message |
| `type` | string enum | `invalid_request_error, authentication_error, permission_error, not_found, rate_limit_error, platform_error, api_error` |
| `code` | string | stable machine-readable code |
| `param` | string | offending request field, when applicable |
| `platform` | string | upstream platform, present when `type: platform_error` |
| `platformError` | object (additionalProperties) | raw upstream payload verbatim |
| `details` | object (additionalProperties) | structured context (e.g. field-level validation errors) |

### Shared responses

- `BadRequest` (400): body is `ErrorResponse`.
- `Unauthorized` (401): body `{ error: string }` (example `"Unauthorized"`).
- `NotFound` (404): body `{ error: string }` (example `"Not found"`).
- `PaymentRequired` (402): body `required: [error, code, reason]` with
  `error: string`, `code: "PAYMENT_REQUIRED"`,
  `reason: free_tier_exceeded | twitter_passthrough | enterprise_required`,
  `documentation_url: uri`, `dashboard_url: uri`, `details: object`.
- `IdempotencyKeyReused` (422): description only, no body schema documented.
- `ResourceGroupForbidden` (403): body `{ error: string, code: insufficient_permissions | unclassified_resource, required_group: string }`
  where `required_group` is one of `publishing, engagement, messages, contacts, analytics, ads, telephony, accounts, billing, webhooks`
  (absent on admin-plane and unclassified-path denials).

### `Idempotency-Key` header parameter

`name: Idempotency-Key`, `in: header`, `required: false`, `schema: { type: string, maxLength: 255 }`.
Same key plus same body replays the original response; same key plus different body gives 422;
key still processing gives 409.

---

## GET /v1/accounts

`operationId: listAccounts`, `x-resource-group: accounts`, tags `[Accounts]`.

Returns connected social accounts. Only accounts within the plan limit by default.
Follower data requires the analytics add-on. Pagination is optional and off by default.

### Query params (all optional)

| name | type | notes |
| --- | --- | --- |
| `profileId` | string | filter by profile. Must be a valid ObjectId |
| `platform` | string | e.g. `instagram`, `twitter` |
| `status` | enum `connected \| disconnected` | `connected` = healthy; `disconnected` = needs reconnection (same check as the dashboard). Omit for any status. With page/limit, pagination totals reflect the filtered set |
| `includeOverLimit` | boolean, default `false` | include accounts from over-limit profiles |
| `page` | integer, min 1 | must be sent together with `limit`, otherwise 400 |
| `limit` | integer, min 1, max 100 | must be sent together with `page`, otherwise 400 |

Out-of-range `page`/`limit` are rejected with 400, not silently clamped.

### Responses

- `200` -> `AccountsListResponse`, `required: [accounts, hasAnalyticsAccess]`:
  - `accounts`: array of `SocialAccount`
  - `hasAnalyticsAccess`: boolean
  - `pagination`: `Pagination`, only present when `page`/`limit` were provided
- `400` -> `BadRequest`
- `401` -> `Unauthorized`

Spec example:

```json
{
  "accounts": [
    {
      "_id": "64e1...",
      "platform": "twitter",
      "profileId": { "_id": "64f0...", "name": "My Brand", "slug": "my-brand" },
      "username": "@acme",
      "displayName": "Acme",
      "profileUrl": "https://x.com/acme",
      "isActive": true
    }
  ],
  "hasAnalyticsAccess": false
}
```

## GET /v1/accounts/{accountId}

**Does not exist.** The path `/v1/accounts/{accountId}` is documented with `put`, `patch` and
`delete` only, and the route file `app/api/v1/accounts/[accountId]/route.ts` exports only
`PUT`, `PATCH` and `DELETE`. To fetch a single account, list with
`GET /v1/accounts?profileId=...` (or unfiltered) and select by `_id` client-side.

The three verbs that DO exist on that path, for completeness (all `x-resource-group: accounts`,
`accountId` is a required path param of type string):

- `PUT` (`updateAccount`) — body `{ username?: string, displayName?: string, xCapabilities?: { analytics?: boolean, inbox?: boolean } }`.
  `xCapabilities` is X/Twitter only and 400s on any other platform. 200 returns
  `{ message, username, displayName, xCapabilities? }` (the `xCapabilities` echo appears only
  when the request body carried one). Errors: 400, 401, 404.
- `PATCH` (`moveAccountToProfile`) — body `required: [profileId]`, `{ profileId: string }`
  (valid ObjectId, owned by the same user as the account). 200 returns `{ message, profileId }`.
  Errors: 400 (missing/invalid profileId), 401, 403 (key lacks access to source account or
  target profile; for profile-restricted keys BOTH the current and target profile must be in scope),
  404 (account or target profile not found).
- `DELETE` (`deleteAccount`) — disconnects and removes the account. 200 returns `{ message }`.
  Errors: 401, 404.

## GET /v1/profiles

`operationId: listProfiles`, `x-resource-group: accounts`, tags `[Profiles]`.

Profiles sorted default-first, then by creation date. Without `limit`/`skip` the full list is
returned unchanged.

### Query params (all optional)

| name | type | notes |
| --- | --- | --- |
| `includeOverLimit` | boolean, default `false` | includes over-limit profiles, marked `isOverLimit: true` |
| `name` | string | exact-match filter on profile name. Documented use: recover a profile id after an ambiguous create (timeout then 409 on retry) |
| `limit` | integer, min 1, max 1000 | page size. When `limit` or `skip` is present the response also carries `total` and `skip`, and echoes `limit` |
| `skip` | integer, min 0 | applied after sorting and filtering |

### Responses

- `200` -> `ProfilesListResponse`:
  - `profiles`: array of `Profile`
  - `total`: integer, only when `limit` or `skip` was passed
  - `skip`: integer, only when `limit` or `skip` was passed
  - `limit`: integer, echo, only when it was passed
- `400` -> `BadRequest`
- `401` -> `Unauthorized`

## POST /v1/profiles

`operationId: createProfile`, `x-resource-group: accounts`, tags `[Profiles]`.

Names are unique per workspace. A duplicate returns 409 whose `details.existingProfileId`
carries the existing profile's id. Sending `Idempotency-Key` makes retries safe: same key plus
same body replays the original 201 with the same `_id`.

### Parameters

- `Idempotency-Key` header (optional, see shared parameter above).

### Request body (`required: true`, `application/json`)

```
required: [name]
{
  name:        string   // required
  description: string   // optional
  color:       string   // optional, example '#ffeda0'
}
```

Spec example: `{ "name": "Marketing Team", "description": "Profile for marketing campaigns", "color": "#4CAF50" }`

### Responses

- `201` -> `ProfileCreateResponse`: `{ message: string, profile: Profile }`
- `400` — "Invalid request" (description only, no schema)
- `401` -> `Unauthorized`
- `402` -> `PaymentRequired`
- `403` — "Profile limit exceeded" (description only)
- `409` — a profile with this name already exists, `code: profile_name_conflict`,
  `details.existingProfileId` carries the id. Also returned while a request with the same
  `Idempotency-Key` is still processing.
- `422` -> `IdempotencyKeyReused`

## GET /v1/profiles/{profileId}

`operationId: getProfile`, `x-resource-group: accounts`, tags `[Profiles]`.

- Path param `profileId`, required, type string.
- `200` -> `ProfileGetResponse`: `{ profile: Profile }`
- `401` -> `Unauthorized`
- `404` -> `NotFound`

(The same path also documents `PUT` `updateProfile` with body `{ name?, description?, color?, isDefault? }`
returning `{ message, profile }` (400/401/404/409), and `DELETE` `deleteProfile` returning `{ message }`
(400 when the profile still has active connected accounts, 401, 403, 404). Both are
`x-resource-group: accounts`.)

## GET /v1/connect/{platform}

`operationId: getConnectUrl`, `x-resource-group: accounts`, tags `[Connect]`.
Explicit `security: [bearerAuth: []]` on the operation.

Initiates an OAuth connection flow and returns an `authUrl` to redirect the user to.
Standard flow: Zernio hosts the selection UI, then redirects to your `redirect_url`.
Headless mode: the user is redirected to your `redirect_url` with raw OAuth data so you can
build your own UI, then you complete via the platform-specific selection endpoints.

### Path param

| name | type | notes |
| --- | --- | --- |
| `platform` | required, string enum | `facebook, instagram, linkedin, twitter, tiktok, youtube, threads, reddit, pinterest, bluesky, googlebusiness, telegram, snapchat, discord, slack, whatsapp` (note: no ads platforms here; those use `/v1/connect/{platform}/ads`) |

### Query params

| name | required | type | notes |
| --- | --- | --- | --- |
| `profileId` | **required** | string | your Zernio profile id, from `/v1/profiles`. For WhatsApp, a Zernio-provisioned number can only be connected on the profile it was provisioned to; any other profile is rejected with 409 |
| `redirect_url` | optional | string (uri) | your redirect after connection completes. Accepts an http(s) URL, a custom app scheme for mobile deeplinks (e.g. `myapp://callback`), or a relative path. Params are appended with the URL API, so an existing query string is preserved. Standard mode appends `connected={platform}&profileId=X&accountId=Y&username=Z`. Headless mode appends OAuth data params for platforms needing selection (LinkedIn orgs, Facebook pages); when no selection is needed the account is created directly and the redirect includes `accountId` |
| `headless` | optional | boolean, default `false` | when true, redirect carries raw OAuth data (`code`, `state`) instead of Zernio's account-selection UI |
| `loginMethod` | optional | enum `instagram_login \| facebook_login`, default `instagram_login` | Instagram only, ignored elsewhere. `instagram_login`: Instagram Login dialog, no Facebook Page needed, no selection step, connects directly. `facebook_login`: "Instagram API with Facebook Login", user authorizes a Facebook Page with a linked IG professional account and the callback continues at `/v1/connect/instagram/select-account`. `facebook_login` supports `headless=true`, redirecting with `profileId`, `tempToken`, `platform=instagram`, `step=select_account` and `connect_token` |

### Responses

- `200`: `{ authUrl: string(uri), state: string }`. `authUrl` is where you send the user;
  `state` is the security parameter, handled automatically.
  Example `state`: `"user123-profile456-1234567890-https://yourdomain.com/callback"`.
- `400` — missing/invalid parameters (e.g. invalid `profileId` format). Description only.
- `401` -> `Unauthorized`
- `402` -> `PaymentRequired` (this is where `free_tier_exceeded` / `twitter_passthrough` /
  `enterprise_required` fire)
- `403` — no access to profile, or BYOK required for AppSumo Twitter. Description only.
- `404` — Profile not found. Description only.

## POST /v1/connect/{platform}

`operationId: handleOAuthCallback`, `x-resource-group: accounts`, tags `[Connect]`.

Exchanges the OAuth authorization code for tokens and connects the account to the profile.

- Path param `platform`, required, type string (plain string here, **not** the enum used on GET).
- Request body (`required: true`, `application/json`), `required: [code, state, profileId]`:
  `{ code: string, state: string, profileId: string }`
- Responses (all description-only, no response schemas):
  - `200` — Account connected
  - `400` — Invalid params
  - `401` -> `Unauthorized`
  - `403` — BYOK required for AppSumo Twitter
  - `500` — internal error while connecting the account
  - `502` — the platform rejected the token exchange (`type: platform_error`; an upstream 4xx
    status is forwarded instead of 502)

## GET /v1/auth/verify

`operationId: verifyCredential`, `x-resource-group: public`, tags `[API Keys]`.

Checks whether the bearer credential on the request is valid without reading any data.
Accepts an API key or an OAuth access token. Intended for clients that must validate a
credential before use (e.g. an MCP server verifying an incoming token).

- No parameters, no request body.
- `200`: `{ valid: boolean, userId: string, authType: "api_key" | "oauth" | "session", scope: string | null }`.
  `scope` is the granted OAuth scopes, space-separated; null for API keys.
  Example: `{ "valid": true, "userId": "6507a1b2c3d4e5f6a7b8c9d0", "authType": "oauth", "scope": "posts:read posts:write accounts:read" }`
- `401` -> `Unauthorized`

Because it is `x-resource-group: public`, no resource group is required to call it.

---

## Resource groups required by API keys

From `docs/RESOURCE-GROUPS-PLAN.md`. The 10 grantable groups (decision 3, "names approved and
permanent") are: `publishing, engagement, messages, contacts, analytics, ads, telephony,
accounts, billing, webhooks`. Two non-grantable classes also exist: `admin-plane` (never
grantable to restricted keys) and `session` / `public`.

The model is an **opt-out denylist**: `ApiKey.disabledResourceGroups?: string[]`. Absent or
empty means legacy full access. A group is on unless it is in the denylist. Restricted keys
carry the `zrk_` prefix. The key-wide `permission: 'read' | 'read-write'` is a separate,
orthogonal axis; there are no per-group read/write levels.

| task | resource group needed |
| --- | --- |
| Creating posts (`/v1/posts/**`) | **`publishing`** |
| Listing accounts (`/v1/accounts/**`) | **`accounts`** |
| Running the OAuth connect flow (`/v1/connect/**` key-authed subset, plus `/v1/profiles/**` to get the `profileId`) | **`accounts`** (both `/v1/connect/**` and `/v1/profiles/**` are classified into `accounts`) |
| Managing webhooks (`/v1/webhooks/**`) | **`webhooks`** |

Two extra facts about `webhooks` that matter for a component doing webhook management:

- A restricted key can only create or edit subscriptions whose event families map to groups the
  key holds. A no-`messages` key cannot subscribe to `message.*`, test-fire it, redeliver it, or
  read its delivery logs. So managing webhooks for a given event family transitively requires that
  family's own group in addition to `webhooks`.
- `/v1/webhooks/logs` omits (does not redact) rows for event families outside the key's groups.

`GET /v1/auth/verify` is classified `public` in the spec, so it requires no group.

A 403 from a resource-group denial carries `code: insufficient_permissions` (or
`unclassified_resource`) plus `required_group`, and the remediation is duplicate-then-revoke:
there is no key-update endpoint, so you create a new key with the group enabled in the dashboard
API keys tab and revoke the old one.

---

## Ambiguities and gaps (flagged, not resolved)

1. **No `GET /v1/accounts/{accountId}`.** Neither the spec nor the route file has it. The task
   brief asked for it; it does not exist. Fetch via the list endpoint and filter on `_id`.
2. **The account id field is `_id`, not `id`.** `SocialAccount` and `Profile` both use `_id`.
   (`ApiKey` in the same spec uses `id`, so the naming is not uniform across the API.)
3. **`profileId` on an account is polymorphic** (`oneOf` string or embedded `Profile`). The spec
   does not say which endpoints or query shapes return which. The `GET /v1/accounts` example
   shows the embedded object form.
4. **`slug` appears in the `GET /v1/accounts` example's embedded profile but is not a `Profile`
   schema property.** Either the example or the schema is out of date; do not rely on `slug`.
5. **`GET /v1/accounts` route code accepts two query params the spec does not document**:
   `includeSandbox` and `excludeHidden` (both boolean, default false), per
   `app/api/v1/accounts/route.ts`. Undocumented, so treat as unstable.
6. **`POST /v1/connect/{platform}` types `platform` as a bare string**, while `GET` uses an enum.
   Unclear whether the POST really accepts a wider set or whether the spec is just looser there.
7. **`POST /v1/connect/{platform}` documents no response schema** for its 200, only the
   description "Account connected". The exact success body (whether it carries `accountId`) is not
   specified.
8. **`POST /v1/profiles` 400 and 403 have descriptions only**, no schema, so the error body shape
   is unconfirmed for those two statuses (409 is described in prose with
   `code: profile_name_conflict` and `details.existingProfileId`).
9. **`GET /v1/connect/{platform}` does not document a 409**, though the `profileId` description
   states WhatsApp connections from the wrong profile are "rejected with a 409".
10. **The `state` value returned by `GET /v1/connect/{platform}` is opaque** but the example shows
    it embedding the user id, profile id, timestamp and callback URL. Treat it as opaque; do not
    parse it.
11. **Idempotency on profile create is documented only for `POST /v1/profiles`.** No
    `Idempotency-Key` parameter is declared on any of the connect endpoints.
