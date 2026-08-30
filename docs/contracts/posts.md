# Zernio Posts HTTP contract

Extracted from `public/openapi.yaml` (OpenAPI 3.1.0, `info.version: 1.0.4`) in the Zernio
monorepo, cross-checked against the route implementations. Lines marked
**[impl]** come from the route/service code rather than the spec, and are called
out wherever the two disagree.

- Base URL: `https://zernio.com/api`
- Auth: global `security: [bearerAuth]`, i.e. `Authorization: Bearer <ZERNIO_API_KEY>`
- Content type: `application/json`

Sources:
- `public/openapi.yaml` lines 12974-14330 (paths), 1382 (`ErrorResponse`), 4346 (`MediaItem`),
  4400 (`PlatformTarget`), 4493 (`Post`), 4544 (`RecyclingConfig`), 4640 (`RecyclingState`),
  5848 (`Pagination`), 5871 (`SocialAccount`), 6597-6640 (post response wrappers), 507-550
  (shared parameters/responses).
- `app/api/v1/posts/route.ts`, `app/api/v1/posts/schema.ts`,
  `app/api/v1/posts/[postId]/route.ts`, `.../retry/route.ts`, `.../unpublish/route.ts`,
  `.../edit/route.ts`, `libs/posts/services/create.ts`, `libs/posts/services/post-builder.ts`,
  `libs/publishing/pipeline/publish-claim.ts`, `models/Post.ts`, `libs/timezone.ts`.

---

## Answers to the three design questions

### How are accounts/platforms specified on create?

Neither `accountIds` nor a bare platform list. It is:

```jsonc
"platforms": [
  { "platform": "twitter", "accountId": "64e1f0a9e2b5af0012ab34cd" },
  { "platform": "linkedin", "accountId": "64e1f0a9e2b5af0012ab34ef" }
]
```

`platforms` is an array of objects, each requiring both `platform` (string enum) and
`accountId` (24-char hex Mongo ObjectId). One entry per destination account. The same
platform may appear more than once with different `accountId`s.

### How are `scheduledFor` and `timezone` expressed?

Two separate top-level body fields, plus an optional per-platform `scheduledFor` override.

- `scheduledFor`: `string`, `format: date-time`. **[impl]** `libs/timezone.ts:60`
  `convertToUTC` branches on the string:
  - ends with `Z` or matches `[+-]HH:MM` → parsed as-is, **`timezone` is ignored**;
  - otherwise (a naive `YYYY-MM-DDTHH:mm[:ss]`) → interpreted as wall-clock time **in
    `timezone`** and converted to UTC.
- `timezone`: `string`, spec default `UTC`. Only meaningful for naive `scheduledFor` values.
- **[impl]** resolution order in `postBuilder.calculateScheduledDate`
  (`libs/posts/services/post-builder.ts:183`): top-level `scheduledFor` → `publishNow`
  (= now) → **earliest** of the per-platform `platforms[].scheduledFor` overrides → now.

### How are drafts created?

A boolean body flag `isDraft` (default `false`). There is no `status` field on the request
body; `status` is response-only.

- `isDraft: true` → post is stored with `status: "draft"`.
- **[impl]** `libs/posts/services/create.ts:866` auto-draft rule: when **none** of
  `scheduledFor`, `publishNow`, `isDraft`, `queuedFromProfile` are provided, `isDraft` is
  forced to `true`. Exception: if *some* `platforms[].scheduledFor` overrides are present
  but not all, the request is rejected with 400 "Ambiguous scheduling" instead.
- Drafts may omit `platforms` entirely. Non-drafts return 400 when `platforms` is empty.
- Drafts skip platform-specific media/field validation, the upload-quota claim, and the
  anti-abuse/velocity checks. **[impl]** identity-field validation still runs on drafts.
- Promoting a draft: `PUT /v1/posts/{postId}` with `isDraft: false` **plus** one of
  `scheduledFor`, `publishNow: true`, or `queuedFromProfile`. Sending only `scheduledFor`
  returns 200 but the post stays a draft.

### What is the media field called?

`mediaItems` (top-level array of `MediaItem`), and `platforms[].customMedia` for a
per-platform override. There is no `mediaUrls`, `media`, or `attachments` field. Each item
carries the URL under `MediaItem.url`.

---

## POST /v1/posts — create / schedule

`operationId: createPost`. Request body required.

### Headers

| Header | Required | Type | Notes |
| --- | --- | --- | --- |
| `x-request-id` | no | string, `format: uuid` | Idempotency key, ~5 minute window. Same value on a second request replays the first instead of creating a duplicate. |

### Body (top level)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `title` | string | no | YouTube: max 100 chars. |
| `content` | string | conditional | Caption/text. Optional when media is attached or every platform has `customContent`. Required for text-only posts. **[impl]** also satisfied when the only platform is `youtube`, or when a twitter entry has `platformSpecificData.article`. |
| `mediaItems` | `MediaItem[]` | no | See `MediaItem` below. |
| `platforms` | `PlatformInput[]` | conditional | Required for non-drafts (400 if empty). Drafts may omit. See below. |
| `scheduledFor` | string (date-time) | no | See timezone semantics above. |
| `publishNow` | boolean, default `false` | no | Publish immediately. Response then carries `platformPostUrl`. |
| `isDraft` | boolean, default `false` | no | Draft flag. See draft rules above. |
| `timezone` | string, default `UTC` | no | IANA name, e.g. `America/New_York`. |
| `tags` | string[] | no | YouTube: each tag max 100 chars, combined max 500, duplicates removed. |
| `hashtags` | string[] | no | |
| `mentions` | string[] | no | Stored for reference only. Does **not** create @mentions at publish time. |
| `crosspostingEnabled` | boolean, default `true` | no | |
| `metadata` | object (free-form) | no | |
| `tiktokSettings` | `TikTokPlatformData` | no | Root-level, merged into each tiktok entry's `platformSpecificData`; per-platform values win. |
| `facebookSettings` | `FacebookSettings` | no | Root-level, merged into each facebook entry's `platformSpecificData.facebookSettings`; per-platform values win. |
| `recycling` | `RecyclingConfig` | no | See below. |
| `queuedFromProfile` | string (ObjectId) | no | Schedule via the profile queue. Without `scheduledFor`, auto-assigns the next slot. Do not pre-call `/v1/queue/next-slot` and pass the result as `scheduledFor` (bypasses queue locking). |
| `queueId` | string (ObjectId) | no | Specific queue. Only honored alongside `queuedFromProfile`. Defaults to the profile's default queue. |

**[impl] Undocumented body fields accepted by `createPostBodySchema`
(`app/api/v1/posts/schema.ts`)** — present in code, absent from the spec:

| Field | Type | Notes |
| --- | --- | --- |
| `visibility` | `'public' \| 'private' \| 'unlisted'` | Documented on PUT only, but accepted on POST. |
| `dryRun` | boolean | TikTok-only quota preview. Returns a preview payload and creates no post; 400 if no tiktok platform is present. |

**[impl]** The create body schema is a Zod `looseObject`, so unknown keys are accepted and
passed through rather than rejected.

### `platforms[]` entry (`PlatformInput`)

Required: `platform`, `accountId`.

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `platform` | string | yes | **[impl]** enum in `app/api/v1/posts/schema.ts`: `tiktok`, `instagram`, `facebook`, `youtube`, `linkedin`, `twitter`, `threads`, `pinterest`, `reddit`, `bluesky`, `googlebusiness`, `telegram`, `snapchat`, `whatsapp`, `discord`, `slack`. The spec types it only as `{ type: string, example: twitter }`. |
| `accountId` | string | yes | 24-char hex ObjectId. Non-ObjectId input is a 400, not a 500. |
| `customContent` | string | no | Replaces the top-level `content` for this platform. |
| `customMedia` | `MediaItem[]` | no | Replaces `mediaItems` for this platform. |
| `scheduledFor` | string (date-time) | no | Per-platform time override. |
| `platformSpecificData` | object | no | Spec: `oneOf` of 15 named `<Platform>PlatformData` schemas. **[impl]** validated as a free-form `Record<string, unknown>`. |
| `profileId` | string (ObjectId) | no | **[impl]** accepted by the Zod schema, undocumented in the spec. |

### `MediaItem`

| Field | Type | Notes |
| --- | --- | --- |
| `type` | enum `image \| video \| gif \| document` | **[impl]** optional; missing types are auto-detected from the URL extension. |
| `url` | string (uri) | Must be publicly reachable over HTTPS. |
| `title` | string | LinkedIn PDF/carousel document title; falls back to post title, then filename. |
| `altText` | string | Applied on platforms with alt-text support. X max 1000 chars, Pinterest max 500. |
| `filename` | string | |
| `size` | integer | Bytes. |
| `mimeType` | string | e.g. `image/jpeg`, `video/mp4`. |
| `thumbnail` | string (uri) | Custom video cover. Facebook video/Reels, LinkedIn video. Max 10MB. |
| `instagramThumbnail` | string (uri) | Instagram Reels cover. Precedence: this > `platformSpecificData.instagramThumbnail` > `.reelCover` > `.thumbnailUrl` (legacy). |
| `tiktokProcessed` | boolean | Internal flag. |
| `width`, `height`, `duration` | number | **[impl]** accepted by the Zod schema, not in the spec's `MediaItem`. |

`MediaItem` is a `looseObject` **[impl]**, so extra keys pass through.

### `RecyclingConfig` (create/update input)

| Field | Type | Notes |
| --- | --- | --- |
| `enabled` | boolean, default `true` | `false` disables recycling on this post. |
| `gap` | integer >= 1 | Intervals between reposts. Required when enabling. |
| `gapFreq` | enum `week \| month`, default `month` | |
| `startDate` | string (date-time) | Defaults to the post's `scheduledFor`. |
| `expireCount` | integer >= 1 or `null` | `null` on update clears the limit. |
| `expireDate` | string (date-time) or `null` | `null` on update clears the limit. |
| `contentVariations` | string[], max 20 | Round-robin per recycle. Send `[]` to clear; otherwise 2+ non-empty entries required. |

Constraints from the schema description: max 10 active recycling posts per account;
YouTube and TikTok are excluded from recycling.

### Responses

| Status | Body | Notes |
| --- | --- | --- |
| `201` | `PostCreateResponse` = `{ message?: string, post?: Post }` | Documented success. |
| `200` | **[impl]** `{ post: Post, message: "Post already exists (idempotent retry)" }` | `x-request-id` replay where the original post is already saved. **Not listed in the spec's `responses` block.** |
| `202` | **[impl]** `{ postId: string, message: "Post is being processed (idempotent retry)" }` | `x-request-id` replay where the original is still in flight. Note: `postId`, not `post`. **Undocumented.** |
| `207` | **[impl]** `{ post, message, error, platformResults, warnings? }` | `publishNow` saved the post but the publish step failed on one or more platforms. `error` is a top-level sibling of `post`. **Undocumented on POST** (documented on PUT and retry). |
| `400` | `{ error: string }` | Validation error. The spec inlines a bare `{error}` object here, not `ErrorResponse`. |
| `401` | `{ error: string }` (`Unauthorized` response) | |
| `403` | `{ error: string, code?: 'ACCOUNT_DISCONNECTED' \| 'PROFILE_OVER_LIMIT' }` | No `code` = the `accountId` is not owned by the caller / outside the API key's profile scope. **[impl]** upload-quota failures also 403 with extra top-level fields spread beside `error` (e.g. `planName`, `limit`, `current`, `billingPeriod`). |
| `409` | `{ error: string, details: { accountId, platform, existingPostId } }` | Content-hash dedup within 24h. **[impl]** `details` is the raw `ClaimConflict`, which also carries `contentHash` and may carry `existingClaimId` (both undocumented). |
| `429` | `{ error: string, details?: object }` + headers `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` | API rate limit, velocity limit (25 posts/hour/account), account cooldown, or daily platform limits. |

**Spec inconsistency (call out before relying on it):** the operation description says the
`x-request-id` replay returns "HTTP 200 with the original post in the `existingPost`
field". **[impl]** `libs/posts/services/create.ts:743` returns it under `post`, and there is
no `existingPost` key in any response. Likewise the description says the 409 returns
`accountId`, `platform`, `existingPostId` at top level, while both the 409 schema and the
implementation nest them under `details`. Trust `post` and `details.*`.

Idempotency ordering (spec): `x-request-id` replay is checked first; only if there is no
match does the content-hash dedup run and possibly 409.

---

## GET /v1/posts — list

`operationId: listPosts`.

### Query parameters (all optional)

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `page` | integer >= 1 | `1` | |
| `limit` | integer 1..500 | `10` | Above the max is a 400, not a clamp. |
| `source` | enum `zernio \| external` | `zernio` | `external` reads posts synced from the platform (up to ~12 months per account). |
| `status` | enum `draft \| scheduled \| published \| failed` | | Narrower than the `Post.status` enum. |
| `platform` | string | | e.g. `twitter`. |
| `profileId` | string | | ObjectId, or `all` / empty for all profiles. |
| `createdBy` | string | | ObjectId of a team user. |
| `dateFrom` | string | | Zero-padded `YYYY-MM-DD` or full ISO 8601. Empty = no filter; other malformed values 400. |
| `dateTo` | string | | Same rules as `dateFrom`. |
| `includeHidden` | boolean | `false` | |
| `search` | string | | Full-text over post content. |
| `sortBy` | enum `scheduled-desc \| scheduled-asc \| created-desc \| created-asc \| status \| platform` | `scheduled-desc` | **[impl]** the Zod schema accepts any string with default `scheduled-desc`; the enum is spec-only. |
| `accountId` | string | | ObjectId of a social account. |
| `timezone` | string | | **[impl]** accepted by `listPostsQuerySchema` and passed into the filters. **Undocumented in the spec.** |

### Responses

| Status | Body |
| --- | --- |
| `200` | `PostsListResponse` = `{ posts: Post[], pagination: Pagination }` |
| `400` | `ErrorResponse` |
| `401` | `{ error: string }` |

`Pagination` = `{ page: integer, limit: integer, total: integer, pages: integer }`.

**Ambiguity:** the spec types the 200 as `PostsListResponse` for both `source` values, but
**[impl]** `source=external` is served by `listExternalPosts` and returns ExternalPost
documents, whose shape is not the `Post` schema. Do not assume the two are interchangeable;
the external shape is not documented on this operation.

---

## GET /v1/posts/{postId} — read one

`operationId: getPost`. Path param `postId`, required, `type: string`. **[impl]** must be a
24-char hex ObjectId; anything else is 400 (`Invalid post ID format`).

| Status | Body |
| --- | --- |
| `200` | `PostGetResponse` = `{ post: Post }` |
| `400` | `ErrorResponse` |
| `401` | `{ error: string }` |
| `403` | `ErrorResponse` |
| `404` | `{ error: string }` |

---

## PUT /v1/posts/{postId} — update

`operationId: updatePost`. Body required. Editable when the post is `draft`, `scheduled`,
`failed`, `partial`, or `cancelled`. Published posts accept only a `recycling` update.

Body fields are the same set as create, minus `crosspostingEnabled` defaults, with these
differences:

- `isDraft`: **no default**. Omitted keeps the current draft status. Send `false` (with
  `scheduledFor` / `publishNow` / `queuedFromProfile`) to promote a draft.
- `visibility`: `public | private | unlisted` (documented here, unlike on create).
- `platforms[].platformSpecificData`: typed as free-form object. A `<platform>Settings`
  namespace omitted from the request is **preserved** from the stored post; sending the key
  **replaces the whole namespace** (no deep merge).
- `tiktokSettings` / `facebookSettings`: 400 if sent without a `platforms` array.
- `additionalProperties: true` on the whole body.

Non-draft updates re-run the same per-platform validation as create.

| Status | Body |
| --- | --- |
| `200` | `PostUpdateResponse` = `{ message?: string, post?: Post, warnings?: string[] }` |
| `207` | Partial publish success. **The spec declares no schema or content for 207 here.** |
| `400` | `ErrorResponse` |
| `401` | `{ error: string }` |
| `403` | `ErrorResponse` |
| `404` | `{ error: string }` |

---

## DELETE /v1/posts/{postId} — delete

`operationId: deletePost`. Deletes a **draft or scheduled** post from Zernio. Published
posts cannot be deleted (use unpublish). Upload quota is refunded automatically.

| Status | Body |
| --- | --- |
| `200` | `PostDeleteResponse` = `{ message?: string }` |
| `400` | `ErrorResponse` (cannot delete published posts) |
| `401` | `{ error: string }` |
| `403` | `ErrorResponse` |
| `404` | `{ error: string }` |

---

## POST /v1/posts/{postId}/retry — retry a failed post

`operationId: retryPost`. No request body. Publishes immediately and returns the updated post.

| Status | Body |
| --- | --- |
| `200` | `PostRetryResponse` = `{ message?: string, post?: Post }` |
| `207` | Partial success. **[impl]** `{ message, error, post }`; the spec declares no schema. |
| `400` | `ErrorResponse` (invalid state) |
| `401` | `{ error: string }` |
| `402` | `{ error: string }` — the account owner has a failed payment. |
| `403` | `ErrorResponse` |
| `404` | `{ error: string }` |
| `409` | `ErrorResponse` — post is currently publishing. |
| `429` | `{ error: string, details?: object }` — API rate limit, velocity limit, or account cooldown. |

---

## Cancel / unpublish

**There is no `POST /v1/posts/{postId}/cancel`.** Two paths exist instead:

1. `DELETE /v1/posts/{postId}` removes a draft or scheduled post outright.
2. `POST /v1/posts/{postId}/unpublish` deletes an already-published post **from the
   platform**, keeping the Zernio record and setting its `status` to `cancelled`.

The `post.cancelled` webhook event exists and is described as "post publishing was
cancelled", so `cancelled` is a real reachable status even though it is missing from the
`Post.status` enum in the spec (see Discrepancies).

### POST /v1/posts/{postId}/unpublish

`operationId: unpublishPost`. Body required.

Body: `{ "platform": string }`, `required: [platform]`, enum:
`threads`, `facebook`, `twitter`, `linkedin`, `youtube`, `pinterest`, `reddit`, `bluesky`,
`googlebusiness`, `telegram`.

Not supported on Instagram, TikTok, or Snapchat. Threaded posts delete all items. YouTube
deletion is permanent.

| Status | Body |
| --- | --- |
| `200` | `{ success: boolean, message: string }` |
| `400` | `ErrorResponse` — platform not supported for deletion, post not on that platform, not published, no platform post ID, or no access token. |
| `401` | `{ error: string }` |
| `403` | `ErrorResponse` |
| `404` | `{ error: string }` |
| `500` | Platform API deletion failed. **No schema declared.** |

---

## POST /v1/posts/{postId}/edit — edit a published post

`operationId: editPost`. Body required: `{ platform, content }`, `required: [platform, content]`.

- `platform`: enum `twitter | discord | facebook | reddit`.
- `content`: string, the new post text. Media edits are unsupported on every platform.

Platform rules from the spec: X requires an active X Premium subscription, must be within
1 hour of publish, max 5 edits, single tweets only, and X returns a **new** post id.
Discord/Facebook/Reddit return the original id unchanged. Facebook only permits editing
posts the same app created. Reddit is self-posts only, body only (title is never editable).

| Status | Body |
| --- | --- |
| `200` | `{ success: boolean, id: string, url: string (uri), message: string }` |
| `400` | Platform unsupported, post not published, edit window expired, not X Premium, missing content, or a platform 4xx. **No schema declared.** |
| `401` | `{ error: string }` |
| `403` | **No schema declared.** |
| `404` | `{ error: string }` |
| `500` | Platform API edit failed, unclassified. **No schema declared.** |

Adjacent paths that exist but are outside this contract:
`POST /v1/posts/sync-external`, `POST /v1/posts/bulk-upload`,
`POST /v1/posts/{postId}/update-metadata`, plus **[impl]** `app/api/v1/posts/bulk-delete`,
`app/api/v1/posts/logs`, `app/api/v1/posts/[postId]/hide`, `.../logs`.

---

## Component schemas

### `Post` (response object, `#/components/schemas/Post`)

| Field | Type | Notes |
| --- | --- | --- |
| `_id` | string | |
| `userId` | string \| `User` | May be expanded. |
| `title` | string | |
| `content` | string | |
| `mediaItems` | `MediaItem[]` | |
| `platforms` | `PlatformTarget[]` | See below. |
| `scheduledFor` | string (date-time) | |
| `timezone` | string | |
| `status` | enum `draft \| scheduled \| publishing \| published \| failed \| partial` | See Discrepancies: `cancelled` is missing. |
| `tags` | string[] | |
| `hashtags` | string[] | |
| `mentions` | string[] | Reference only. |
| `visibility` | enum `public \| private \| unlisted` | |
| `metadata` | object | |
| `recycling` | `RecyclingState` | Read model, not `RecyclingConfig`. |
| `recycledFromPostId` | string | Set when this post came from recycling. |
| `queuedFromProfile` | string | |
| `queueId` | string | |
| `createdAt` | string (date-time) | |
| `updatedAt` | string (date-time) | |

The spec's `Post` declares **no `required` list**, so every field must be treated as
optional when decoding.

### `PlatformTarget` (the `platforms[]` entry on a response)

| Field | Type | Notes |
| --- | --- | --- |
| `platform` | string | Description lists: twitter, threads, instagram, youtube, facebook, linkedin, pinterest, reddit, tiktok, bluesky, googlebusiness, telegram. Note this list omits snapchat/discord/slack/whatsapp, which the create schema accepts. |
| `accountId` | string \| `SocialAccount` | **Expanded to a full `SocialAccount` object in every documented response example**, while the request takes a plain string. Decode as a union. |
| `customContent` | string | |
| `customMedia` | `MediaItem[]` | |
| `scheduledFor` | string (date-time) | |
| `platformSpecificData` | object (`oneOf` of the 15 platform schemas, `additionalProperties: true`) | |
| `status` | string | Described as `pending`, `publishing`, `published`, `failed`. **[impl]** `models/Post.ts:65` enum is `pending`, `processing`, `published`, `failed`, `cancelled`, `uploading` — note `processing`, not `publishing`, plus `cancelled` and `uploading`. |
| `platformPostId` | string | Native post id after publish. |
| `platformPostUrl` | string (uri) | Present for immediate posts; for scheduled posts, re-fetch after publish time. |
| `publishedAt` | string (date-time) | Per-platform publish timestamp. |
| `removedFromPlatformAt` | string \| null (date-time) | Set when a published post later disappears from the platform. `status` stays `published`. Detected on the analytics sync, so hours of lag. |
| `isTrialReel` | boolean | Instagram trial reels only; creation-time intent. |
| `trialGraduationStrategy` | enum `MANUAL \| SS_PERFORMANCE` | Only when `isTrialReel`. |
| `errorMessage` | string | When `status: failed`. |
| `errorCategory` | enum `auth_expired \| user_content \| user_abuse \| account_issue \| platform_rejected \| platform_error \| system_error \| unknown` | **[impl]** the model also allows `platform_rate_limit`, which the spec omits. |
| `errorSource` | enum `user \| platform \| system` | |

### `SocialAccount` (expanded `accountId`)

`required: [_id, platform, profileId, isActive]`. Fields: `_id`, `platform` (23-value enum
including ads platforms), `profileId` (string \| `Profile`), `username`, `displayName`,
`profilePicture` (string \| null), `profileUrl`, `isActive`, `needsReconnection`,
`followersCount`, `followersLastUpdated`, `parentAccountId` (string \| null), `enabled`,
`metadata`. The documented response examples only ever populate `_id`, `platform`,
`username`, `displayName`, `isActive`.

### `RecyclingState` (response side of `recycling`)

`enabled`, `gap`, `gapFreq` (`week | month`), `startDate`, `expireCount`, `expireDate`,
`contentVariations` (string[]), `contentVariationIndex` (read-only), `recycleCount`
(read-only).

### `ErrorResponse` (canonical envelope)

| Field | Type | Notes |
| --- | --- | --- |
| `error` | string | Human-readable message. |
| `type` | enum `invalid_request_error \| authentication_error \| permission_error \| not_found \| rate_limit_error \| platform_error \| api_error` | |
| `code` | string | Stable machine-readable code. |
| `param` | string | Offending request field. |
| `platform` | string | Present when `type: platform_error` (e.g. `meta`, `google`, `tiktok`). |
| `platformError` | object (free-form) | Raw upstream payload, verbatim. Meta: `error_subcode`, `error_user_title`, `error_user_msg`. |
| `details` | object (free-form) | Field-level validation errors or other structured context. |

No `required` list, so every field is optional. **Important:** several post operations do
**not** use this envelope. `POST /v1/posts` 400/403/409/429 and the shared `Unauthorized` /
`NotFound` responses declare a bare `{ error: string }` object instead. Decode defensively:
`error` is the only field guaranteed across all of them.

### Response wrappers

```
PostsListResponse  = { posts?: Post[], pagination?: Pagination }
PostGetResponse    = { post?: Post }
PostCreateResponse = { message?: string, post?: Post }
PostUpdateResponse = { message?: string, post?: Post, warnings?: string[] }
PostDeleteResponse = { message?: string }
PostRetryResponse  = { message?: string, post?: Post }
Pagination         = { page?: int, limit?: int, total?: int, pages?: int }
```

None declare `required`, so all keys are optional in the contract.

---

## Discrepancies and ambiguities (do not guess past these)

1. **`existingPost` does not exist.** The create operation's description promises the
   idempotent 200 carries the original under `existingPost`. **[impl]** it is returned under
   `post`. Read `post`.
2. **The 200 / 202 / 207 create statuses are undocumented.** The spec's `responses` block for
   `POST /v1/posts` lists only 201/400/401/403/409/429, yet the same operation's description
   promises a 200, and **[impl]** 202 and 207 are also reachable. A client that treats
   "not 201" as failure will break on a retry.
3. **202 returns `postId`, not `post`.** Different shape from every other success.
4. **409 field placement.** The prose says top-level `accountId`/`platform`/`existingPostId`;
   the schema and the implementation put them under `details`, which also carries
   `contentHash` and sometimes `existingClaimId`.
5. **`Post.publishedAt` is used in examples but is not in the schema, and is not on the
   model.** Several documented examples (list, get, create) show a top-level
   `post.publishedAt`. The `Post` schema has no such property, and **[impl]** `models/Post.ts`
   defines `publishedAt` only inside `platforms[]`. Treat a top-level `publishedAt` as
   unconfirmed; the reliable timestamp is `platforms[].publishedAt`.
6. **`Post.status` omits `cancelled` and the list filter omits more.** Schema enum:
   `draft, scheduled, publishing, published, failed, partial`. **[impl]** `models/Post.ts:101`
   adds `cancelled`, which unpublish sets and the `post.cancelled` webhook reports. The
   `GET /v1/posts?status=` filter accepts only `draft, scheduled, published, failed`, so
   there is no documented way to filter for `publishing`, `partial`, or `cancelled`.
7. **`platforms[].status` values differ between spec and model.** Spec description says
   `pending, publishing, published, failed`; the model enum is
   `pending, processing, published, failed, cancelled, uploading`.
8. **`errorCategory`** in the model includes `platform_rate_limit`, absent from the spec enum.
9. **`platform` is under-typed on responses.** `PlatformTarget.platform` is a bare `string`
   with a prose list that omits snapchat, discord, slack, and whatsapp, all of which the
   create schema accepts. Do not build a closed response-side enum from the spec.
10. **`accountId` is a union on responses.** String in requests, expanded `SocialAccount`
    object in every response example. The schema is `oneOf`, so both are legal, and nothing
    documents when each is used.
11. **`source=external` returns an undocumented shape.** The 200 is typed `PostsListResponse`
    for both sources, but **[impl]** the external branch is a different collection.
12. **Several error statuses declare no schema at all**: PUT 207, retry 207, unpublish 500,
    edit 400/403/500. Body shape is unspecified.
13. **`sortBy` is looser at runtime than in the spec** (`z.string()` with a default, no enum).
    An unknown value will not 400 at the Zod layer.
14. **Undocumented but accepted inputs**: `dryRun` and `visibility` on create,
    `platforms[].profileId`, `MediaItem.width/height/duration`, and the `timezone` list query
    param. Both body schemas are Zod `looseObject`s, so unknown keys are not rejected.
