import { DAY, MINUTE, HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { NonRetryableError, Workpool, type WorkId } from "@convex-dev/workpool";
import type { FunctionHandle } from "convex/server";
import { ConvexError, v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import {
  accountBlockFrom,
  accountUpsertsFrom,
  applyPlatformBlock,
  firstPlatformError,
  isConsumedAccountEvent,
  isConsumedPostEvent,
  isPlatformEvent,
  platformTargetsFrom,
  postProjectionId,
  postProjectionPlatforms,
  postTransitionFor,
} from "./events.js";
import schema from "./schema.js";
import {
  deriveIdempotencyKey,
  isRecord,
  isTerminalPostStatus,
  mapZernioPostStatus,
  normalizeZernioId,
  parseTimestamp,
  readArray,
  readRecord,
  readString,
  vPlatformTarget,
  vPostStatus,
  vRuntimeOptions,
  type AccountEventArgs,
  type PlatformTarget,
  type PostEventArgs,
  type PostStatus,
  type RuntimeOptions,
} from "./shared.js";
import {
  buildCreatePostBody,
  isPermanentFailure,
  readSocialAccounts,
  zernioApiError,
  zernioErrorMessage,
  zernioFetch,
  type ZernioResponse,
} from "./zernio.js";

const DEFAULT_MAX_PARALLELISM = 5;

/**
 * How long a derived idempotency key keeps blocking a new submission after the
 * post it created settled. Long enough to absorb a client retry, short enough
 * that reposting the same content next week is not a silent no-op. An explicit
 * caller-supplied key ignores this: that key is the caller's own contract.
 */
const DERIVED_KEY_WINDOW_MS = 10 * MINUTE;

/** Webhook payloads are dropped past this age; the dedup row itself is kept. */
const PAYLOAD_RETENTION_MS = 30 * DAY;

/** How many expired payloads each incoming webhook clears. */
const PAYLOAD_PRUNE_BATCH = 10;

/** Clock-skew slack when matching a Zernio post back to a retried submission. */
const RECONCILE_SLACK_MS = 5 * MINUTE;

const UNRESOLVED_STATUSES: readonly PostStatus[] = [
  "pending",
  "submitting",
  "scheduled",
];

const postWorkpool = new Workpool(components.postWorkpool, {
  maxParallelism: DEFAULT_MAX_PARALLELISM,
});

const rateLimiter = new RateLimiter(components.rateLimiter, {
  // A conservative client-side guard, not a documented Zernio number.
  zernioApi: { kind: "token bucket", rate: 120, period: MINUTE, capacity: 30 },
  // Zernio's documented velocity limit: 25 posts per hour per account.
  postsPerAccount: { kind: "fixed window", rate: 25, period: HOUR },
});

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

const vAccountUpsert = v.object({
  zernioAccountId: v.string(),
  platform: v.string(),
  username: v.string(),
  displayName: v.optional(v.string()),
  avatarUrl: v.optional(v.string()),
  isActive: v.boolean(),
});

export const schedulePost = mutation({
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
  },
  returns: v.object({
    postId: v.id("posts"),
    status: vPostStatus,
    duplicate: v.boolean(),
  }),
  // Explicit return types on every handler that references `internal.lib.*`:
  // without them the module's inferred types are circular.
  handler: async (
    ctx,
    args,
  ): Promise<{
    postId: Id<"posts">;
    status: PostStatus;
    duplicate: boolean;
  }> => {
    await storeOptions(ctx, args.options);
    const zernioProfileId = await resolveStoredProfileId(ctx, args);
    const idempotencyKey =
      args.idempotencyKey ??
      deriveIdempotencyKey({
        zernioProfileId,
        accountIds: args.accountIds,
        content: args.content,
        title: args.title,
        mediaUrls: args.mediaUrls,
        scheduledFor: args.scheduledFor,
        testMode: args.options.testMode,
      });
    const duplicate = await findDuplicatePost(ctx, {
      zernioProfileId,
      idempotencyKey,
      explicitKey: args.idempotencyKey !== undefined,
    });
    if (duplicate !== null) {
      return {
        postId: duplicate._id,
        status: duplicate.status,
        duplicate: true,
      };
    }
    const platforms = await resolvePlatformTargets(ctx, {
      zernioProfileId,
      accountIds: args.accountIds,
    });
    if (!args.options.testMode) {
      // Zernio's velocity limit applies when the post publishes, not when it is
      // queued, so the bucket is the target hour: scheduling a month of content
      // in one loop must not 429.
      const publishHour = Math.floor((args.scheduledFor ?? Date.now()) / HOUR);
      for (const accountId of args.accountIds) {
        await rateLimiter.limit(ctx, "postsPerAccount", {
          key: `${accountId}:${publishHour}`,
          throws: true,
        });
      }
    }
    const postId = await ctx.db.insert("posts", {
      zernioProfileId,
      status: "pending",
      content: args.content,
      title: args.title,
      mediaUrls: args.mediaUrls,
      scheduledFor: args.scheduledFor,
      timezone: args.timezone,
      accountIds: args.accountIds,
      platforms,
      idempotencyKey,
      testMode: args.options.testMode,
    });
    // Workpool reads its options on each enqueue, so the caller's
    // maxParallelism needs its own instance rather than the module-level one.
    const workpool = new Workpool(components.postWorkpool, {
      maxParallelism: args.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
    });
    const workId = await workpool.enqueueAction(
      ctx,
      internal.lib.submitPost,
      { postId, options: args.options, apiKey: args.apiKey },
      {
        onComplete: internal.lib.onSubmitComplete,
        context: { postId },
        // Zernio's account cooldowns escalate in tens of minutes, so the whole
        // retry envelope has to span one: 1m, 4m, 16m, 64m. Re-POSTing after a
        // failed attempt is safe because every attempt past the first
        // reconciles against Zernio before it would create a second post.
        retry: { maxAttempts: 5, initialBackoffMs: MINUTE, base: 4 },
      },
    );
    await ctx.db.patch("posts", postId, { workId });
    return { postId, status: "pending" as const, duplicate: false };
  },
});

export const getPost = query({
  args: {
    postId: v.string(),
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
  },
  returns: v.union(v.null(), vPostDoc),
  handler: async (ctx, args) => {
    return await ownedPost(ctx, args);
  },
});

export const getPostStatus = query({
  args: {
    postId: v.string(),
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
  },
  returns: v.union(v.null(), vPostStatusSummary),
  handler: async (ctx, args) => {
    const post = await ownedPost(ctx, args);
    if (post === null) {
      return null;
    }
    return {
      postId: post._id,
      status: post.status,
      zernioPostId: post.zernioPostId ?? null,
      scheduledFor: post.scheduledFor ?? null,
      platforms: post.platforms,
      errorMessage: post.errorMessage ?? null,
      testMode: post.testMode,
      submittedAt: post.submittedAt ?? null,
      finalizedAt: post.finalizedAt ?? null,
    };
  },
});

export const listPosts = query({
  args: {
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
    status: v.optional(vPostStatus),
    limit: v.optional(v.number()),
  },
  returns: v.array(vPostDoc),
  handler: async (ctx, args) => {
    const zernioProfileId = await lookupProfileId(ctx, args);
    if (zernioProfileId === null) {
      return [];
    }
    const status = args.status;
    // by_profile_status descends (profileId, status, _creationTime), so with the
    // status left unbound it would order by status name, not by recency.
    if (status === undefined) {
      return await ctx.db
        .query("posts")
        .withIndex("by_profile_creation", (q) =>
          q.eq("zernioProfileId", zernioProfileId),
        )
        .order("desc")
        .take(args.limit ?? 50);
    }
    return await ctx.db
      .query("posts")
      .withIndex("by_profile_status", (q) =>
        q.eq("zernioProfileId", zernioProfileId).eq("status", status),
      )
      .order("desc")
      .take(args.limit ?? 50);
  },
});

export const listAccounts = query({
  args: {
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
    platform: v.optional(v.string()),
  },
  returns: v.array(vAccountDoc),
  handler: async (ctx, args) => {
    const zernioProfileId = await lookupProfileId(ctx, args);
    if (zernioProfileId === null) {
      return [];
    }
    return await profileAccounts(ctx, zernioProfileId, args.platform);
  },
});

export const connectUrl = action({
  args: {
    options: vRuntimeOptions,
    apiKey: v.string(),
    platform: v.string(),
    redirectUrl: v.optional(v.string()),
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
    profileName: v.optional(v.string()),
  },
  returns: v.object({
    authUrl: v.string(),
    state: v.string(),
    zernioProfileId: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ authUrl: string; state: string; zernioProfileId: string }> => {
    await ctx.runMutation(internal.lib.setOptions, { options: args.options });
    const zernioProfileId = await ensureProfileId(ctx, args);
    await consumeApiToken(ctx, zernioProfileId);
    const response = await zernioFetch({
      baseUrl: args.options.baseUrl,
      apiKey: args.apiKey,
      method: "GET",
      path: `/v1/connect/${encodeURIComponent(args.platform)}`,
      query: {
        profileId: zernioProfileId,
        ...(args.redirectUrl !== undefined
          ? { redirect_url: args.redirectUrl }
          : {}),
      },
    });
    if (!response.ok) {
      throw zernioApiError(response, "Failed to start the Zernio OAuth flow");
    }
    const authUrl = readString(response.data, "authUrl");
    const state = readString(response.data, "state");
    if (authUrl === null || state === null) {
      throw new ConvexError({
        kind: "zernio_api_error",
        status: response.status,
        message: "Zernio connect response carried no authUrl and state",
      });
    }
    return { authUrl, state, zernioProfileId };
  },
});

export const syncAccounts = action({
  args: {
    options: vRuntimeOptions,
    apiKey: v.string(),
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
    profileName: v.optional(v.string()),
  },
  returns: v.array(vAccountDoc),
  handler: async (ctx, args): Promise<Doc<"accounts">[]> => {
    await ctx.runMutation(internal.lib.setOptions, { options: args.options });
    const zernioProfileId = await ensureProfileId(ctx, args);
    await consumeApiToken(ctx, zernioProfileId);
    // page and limit must be sent together or the API 400s, and the
    // unpaginated response is already the full in-limit set.
    const response = await zernioFetch({
      baseUrl: args.options.baseUrl,
      apiKey: args.apiKey,
      method: "GET",
      path: "/v1/accounts",
      query: { profileId: zernioProfileId },
    });
    if (!response.ok) {
      throw zernioApiError(response, "Failed to list Zernio accounts");
    }
    return await ctx.runMutation(internal.lib.upsertAccounts, {
      zernioProfileId,
      accounts: accountUpsertsFrom(readSocialAccounts(response.data)),
      deactivateMissing: true,
    });
  },
});

export const cancelPost = action({
  args: {
    options: vRuntimeOptions,
    apiKey: v.string(),
    postId: v.string(),
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
  },
  returns: v.object({
    postId: v.id("posts"),
    status: vPostStatus,
    cancelled: v.boolean(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    postId: Id<"posts">;
    status: PostStatus;
    cancelled: boolean;
  }> => {
    await ctx.runMutation(internal.lib.setOptions, { options: args.options });
    const post: Doc<"posts"> | null = await ctx.runQuery(
      internal.lib.getPostInternal,
      {
        postId: args.postId,
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        ...(args.zernioProfileId !== undefined
          ? { zernioProfileId: args.zernioProfileId }
          : {}),
      },
    );
    if (post === null) {
      throw new ConvexError({
        kind: "zernio_post_not_found",
        message: `Unknown post ${args.postId}`,
      });
    }
    if (post.status === "cancelled") {
      return { postId: post._id, status: post.status, cancelled: false };
    }
    if (post.status === "published" || post.status === "partial") {
      throw new ConvexError({
        kind: "zernio_cannot_cancel",
        message: `Post ${post._id} is already ${post.status}. Remove it from the platform with request() and POST /v1/posts/{id}/unpublish.`,
      });
    }
    if (
      (post.status === "pending" || post.status === "submitting") &&
      post.workId !== undefined
    ) {
      // The schema stores the opaque WorkId as a plain string.
      await postWorkpool.cancel(ctx, post.workId as WorkId);
    }
    // Cancelling the job is not enough once Zernio holds the post: a submission
    // that already returned an id publishes on Zernio's schedule, whatever the
    // local status says.
    if (post.zernioPostId !== undefined) {
      await consumeApiToken(ctx, post.zernioProfileId);
      const response = await zernioFetch({
        baseUrl: args.options.baseUrl,
        apiKey: args.apiKey,
        method: "DELETE",
        path: `/v1/posts/${post.zernioPostId}`,
      });
      // A failed post may never have reached Zernio, so its delete is best effort.
      if (!response.ok && post.status !== "failed") {
        throw zernioApiError(response, "Failed to delete the Zernio post");
      }
    }
    await ctx.runMutation(internal.lib.markPostCancelled, { postId: post._id });
    return {
      postId: post._id,
      status: "cancelled" as const,
      cancelled: true,
    };
  },
});

export const request = action({
  args: {
    options: vRuntimeOptions,
    apiKey: v.string(),
    method: v.union(
      v.literal("GET"),
      v.literal("POST"),
      v.literal("PUT"),
      v.literal("PATCH"),
      v.literal("DELETE"),
    ),
    path: v.string(),
    query: v.optional(v.record(v.string(), v.string())),
    body: v.optional(v.any()),
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
  },
  returns: v.object({
    status: v.number(),
    ok: v.boolean(),
    data: v.any(),
  }),
  handler: async (ctx, args) => {
    // An absolute URL would send the API key to another host.
    if (!args.path.startsWith("/")) {
      throw new ConvexError({
        kind: "zernio_invalid_path",
        message: `path must start with "/", got ${args.path}`,
      });
    }
    // Keyed on the tenant, like every other outbound call, so one tenant's
    // polling cannot drain the budget of the rest. Unresolved callers (a cron
    // with no auth and no configured profile) share the fallback bucket.
    await consumeApiToken(
      ctx,
      args.zernioProfileId ?? args.userId ?? "unscoped",
    );
    const response = await zernioFetch({
      baseUrl: args.options.baseUrl,
      apiKey: args.apiKey,
      method: args.method,
      path: args.path,
      query: args.query,
      body: args.body,
    });
    return { status: response.status, ok: response.ok, data: response.data };
  },
});

export const handleWebhookEvent = mutation({
  args: {
    options: v.optional(vRuntimeOptions),
    eventId: v.string(),
    event: v.string(),
    payload: v.any(),
    receivedAt: v.optional(v.number()),
  },
  returns: v.object({
    deduped: v.boolean(),
    applied: v.boolean(),
    postId: v.union(v.null(), v.id("posts")),
    accountId: v.union(v.null(), v.id("accounts")),
  }),
  handler: async (ctx, args): Promise<WebhookResult> => {
    const seen = await ctx.db
      .query("postEvents")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .first();
    if (seen !== null) {
      return {
        deduped: true,
        applied: false,
        postId: seen.postId ?? null,
        accountId: null,
      };
    }
    if (args.options !== undefined) {
      await storeOptions(ctx, args.options);
    }
    const options = args.options ?? (await readOptions(ctx));
    const receivedAt = args.receivedAt ?? Date.now();
    await prunePayloads(ctx, receivedAt);
    if (isConsumedPostEvent(args.event)) {
      return await applyPostEvent(ctx, {
        options,
        eventId: args.eventId,
        event: args.event,
        payload: args.payload,
        receivedAt,
      });
    }
    if (isConsumedAccountEvent(args.event)) {
      return await applyAccountEvent(ctx, {
        options,
        eventId: args.eventId,
        event: args.event,
        payload: args.payload,
        receivedAt,
      });
    }
    return { deduped: false, applied: false, postId: null, accountId: null };
  },
});

export const submitPost = internalAction({
  args: {
    postId: v.id("posts"),
    options: vRuntimeOptions,
    apiKey: v.string(),
  },
  returns: v.object({
    zernioPostId: v.union(v.null(), v.string()),
    status: vPostStatus,
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ zernioPostId: string | null; status: PostStatus }> => {
    const gate: { proceed: boolean; attempt: number } = await ctx.runMutation(
      internal.lib.markSubmitting,
      { postId: args.postId },
    );
    const post: Doc<"posts"> | null = await ctx.runQuery(
      internal.lib.getPostInternal,
      { postId: args.postId },
    );
    if (post === null) {
      throw new NonRetryableError(`Post ${args.postId} no longer exists`);
    }
    if (!gate.proceed || post.zernioPostId !== undefined) {
      return { zernioPostId: post.zernioPostId ?? null, status: post.status };
    }
    // A previous attempt may have created the post before it failed, and
    // Zernio's `x-request-id` replay is behind a rollout flag, so it cannot be
    // the only thing standing between a retry and a second live post.
    if (gate.attempt > 1) {
      const adopted = await reconcileSubmission(ctx, {
        post,
        options: args.options,
        apiKey: args.apiKey,
      });
      if (adopted !== null) {
        return adopted;
      }
    }
    const limit = await rateLimiter.limit(ctx, "zernioApi", {
      key: post.zernioProfileId,
    });
    if (!limit.ok) {
      throw new Error(
        `Zernio API rate limit reached, retry in ${limit.retryAfter}ms`,
      );
    }
    const response = await zernioFetch({
      baseUrl: args.options.baseUrl,
      apiKey: args.apiKey,
      method: "POST",
      path: "/v1/posts",
      // Replays a call that already reached Zernio, for about 5 minutes.
      headers: { "x-request-id": post.idempotencyKey },
      body: buildCreatePostBody({
        content: post.content,
        title: post.title,
        mediaUrls: post.mediaUrls,
        timezone: post.timezone,
        scheduledFor: post.scheduledFor,
        platforms: post.platforms,
        testMode: args.options.testMode,
      }),
    });
    return await recordCreateResponse(ctx, {
      post,
      response,
      options: args.options,
      apiKey: args.apiKey,
    });
  },
});

export const onSubmitComplete = postWorkpool.defineOnComplete({
  context: v.object({ postId: v.id("posts") }),
  handler: async (ctx: MutationCtx, { context, result }) => {
    if (result.kind === "success") {
      return;
    }
    const post = await ctx.db.get("posts", context.postId);
    if (post === null || post.status === "cancelled") {
      return;
    }
    if (isTerminalPostStatus(post.status)) {
      return;
    }
    if (result.kind === "canceled") {
      await ctx.db.patch("posts", context.postId, {
        status: "cancelled",
        finalizedAt: Date.now(),
      });
      return;
    }
    await ctx.db.patch("posts", context.postId, {
      status: "failed",
      errorMessage: result.error,
      finalizedAt: Date.now(),
    });
  },
});

export const markSubmitting = internalMutation({
  args: { postId: v.id("posts") },
  returns: v.object({ proceed: v.boolean(), attempt: v.number() }),
  handler: async (ctx, args) => {
    const post = await ctx.db.get("posts", args.postId);
    if (
      post === null ||
      (post.status !== "pending" && post.status !== "submitting")
    ) {
      return { proceed: false, attempt: post?.submitAttempts ?? 0 };
    }
    const attempt = (post.submitAttempts ?? 0) + 1;
    await ctx.db.patch("posts", args.postId, {
      status: "submitting",
      // The first attempt's instant, so a reconcile knows how far back to look.
      submittedAt: post.submittedAt ?? Date.now(),
      submitAttempts: attempt,
    });
    return { proceed: true, attempt };
  },
});

export const recordSubmission = internalMutation({
  args: {
    postId: v.id("posts"),
    zernioPostId: v.string(),
    status: vPostStatus,
    platforms: v.array(vPlatformTarget),
    errorMessage: v.optional(v.string()),
    finalized: v.boolean(),
  },
  returns: v.object({ cancelled: v.boolean() }),
  handler: async (ctx, args) => {
    const post = await ctx.db.get("posts", args.postId);
    if (post === null) {
      return { cancelled: false };
    }
    // A cancel that landed while the create was in flight keeps its status, but
    // still records the id so the post can be deleted from Zernio afterwards.
    const cancelled = post.status === "cancelled";
    await ctx.db.patch("posts", args.postId, {
      zernioPostId: args.zernioPostId,
      platforms: args.platforms,
      ...(args.errorMessage !== undefined
        ? { errorMessage: args.errorMessage }
        : {}),
      ...(cancelled ? {} : { status: args.status }),
      ...(!cancelled && args.finalized ? { finalizedAt: Date.now() } : {}),
    });
    return { cancelled };
  },
});

export const recordSubmissionFailure = internalMutation({
  args: { postId: v.id("posts"), errorMessage: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const post = await ctx.db.get("posts", args.postId);
    if (post === null || post.status === "cancelled") {
      return null;
    }
    await ctx.db.patch("posts", args.postId, {
      status: "failed",
      errorMessage: args.errorMessage,
      finalizedAt: Date.now(),
    });
    return null;
  },
});

export const markPostCancelled = internalMutation({
  args: { postId: v.id("posts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const post = await ctx.db.get("posts", args.postId);
    if (post === null) {
      return null;
    }
    await ctx.db.patch("posts", args.postId, {
      status: "cancelled",
      finalizedAt: Date.now(),
      platforms: post.platforms.map((target) =>
        target.status === "published" || target.status === "failed"
          ? target
          : { ...target, status: "cancelled" as const },
      ),
    });
    return null;
  },
});

export const getPostInternal = internalQuery({
  args: {
    postId: v.string(),
    userId: v.optional(v.string()),
    zernioProfileId: v.optional(v.string()),
  },
  returns: v.union(v.null(), vPostDoc),
  handler: async (ctx, args) => {
    return await ownedPost(ctx, args);
  },
});

export const getPostByZernioId = internalQuery({
  args: { zernioPostId: v.string() },
  returns: v.union(v.null(), vPostDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("posts")
      .withIndex("by_zernioPostId", (q) =>
        q.eq("zernioPostId", args.zernioPostId),
      )
      .first();
  },
});

export const setOptions = internalMutation({
  args: { options: vRuntimeOptions },
  returns: v.null(),
  handler: async (ctx, args) => {
    await storeOptions(ctx, args.options);
    return null;
  },
});

export const getOptions = internalQuery({
  args: {},
  returns: v.union(v.null(), vRuntimeOptions),
  handler: async (ctx) => {
    return await readOptions(ctx);
  },
});

export const getProfileIdForUser = internalQuery({
  args: { userId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    return profile?.zernioProfileId ?? null;
  },
});

export const upsertProfileMapping = internalMutation({
  args: { userId: v.string(), zernioProfileId: v.string() },
  returns: v.string(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    // A racing double-create keeps the first profile, so a user never ends up
    // with two Zernio profiles.
    if (existing !== null) {
      return existing.zernioProfileId;
    }
    await ctx.db.insert("profiles", {
      userId: args.userId,
      zernioProfileId: args.zernioProfileId,
    });
    return args.zernioProfileId;
  },
});

export const upsertAccounts = internalMutation({
  args: {
    zernioProfileId: v.string(),
    accounts: v.array(vAccountUpsert),
    deactivateMissing: v.boolean(),
  },
  returns: v.array(vAccountDoc),
  handler: async (ctx, args) => {
    const syncedAt = Date.now();
    for (const account of args.accounts) {
      await upsertAccount(ctx, {
        ...account,
        zernioProfileId: args.zernioProfileId,
        syncedAt,
      });
    }
    if (args.deactivateMissing) {
      const seen = new Set(
        args.accounts.map((account) => account.zernioAccountId),
      );
      const rows = await profileAccounts(ctx, args.zernioProfileId);
      for (const row of rows) {
        if (!seen.has(row.zernioAccountId) && row.isActive) {
          // Never deleted: historical posts still resolve their target account.
          await ctx.db.patch("accounts", row._id, { isActive: false });
        }
      }
    }
    return await profileAccounts(ctx, args.zernioProfileId);
  },
});

async function upsertAccount(
  ctx: MutationCtx,
  row: {
    zernioAccountId: string;
    zernioProfileId: string;
    platform: string;
    username: string;
    displayName?: string;
    avatarUrl?: string;
    isActive: boolean;
    syncedAt: number;
    lastEventAt?: number;
  },
): Promise<Doc<"accounts">["_id"]> {
  const existing = await ctx.db
    .query("accounts")
    .withIndex("by_zernioAccountId", (q) =>
      q.eq("zernioAccountId", row.zernioAccountId),
    )
    .first();
  if (existing === null) {
    return await ctx.db.insert("accounts", row);
  }
  await ctx.db.patch("accounts", existing._id, row);
  return existing._id;
}

async function profileAccounts(
  ctx: QueryCtx,
  zernioProfileId: string,
  platform?: string,
): Promise<Doc<"accounts">[]> {
  return await ctx.db
    .query("accounts")
    .withIndex("by_profile", (q) =>
      platform === undefined
        ? q.eq("zernioProfileId", zernioProfileId)
        : q.eq("zernioProfileId", zernioProfileId).eq("platform", platform),
    )
    .collect();
}

async function lookupProfileId(
  ctx: QueryCtx,
  args: { userId?: string; zernioProfileId?: string },
): Promise<string | null> {
  const userId = args.userId;
  if (userId === undefined) {
    return args.zernioProfileId ?? null;
  }
  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_userId", (q) => q.eq("userId", userId))
    .first();
  return profile?.zernioProfileId ?? null;
}

async function resolveStoredProfileId(
  ctx: QueryCtx,
  args: { userId?: string; zernioProfileId?: string },
): Promise<string> {
  const zernioProfileId = await lookupProfileId(ctx, args);
  if (zernioProfileId !== null) {
    return zernioProfileId;
  }
  throw new ConvexError({
    kind: "zernio_no_profile",
    message:
      args.userId === undefined
        ? "No Zernio profile: pass options.profileId or ZERNIO_PROFILE_ID."
        : `No Zernio profile for user ${args.userId}. Call connectAccountUrl or syncAccounts first.`,
  });
}

/**
 * Resolves a post the caller owns. An id belonging to another profile is
 * indistinguishable from an unknown one, and a malformed id is `null` rather
 * than a validator error, so a stale route param cannot crash a query.
 */
async function ownedPost(
  ctx: QueryCtx,
  args: { postId: string; userId?: string; zernioProfileId?: string },
): Promise<Doc<"posts"> | null> {
  const postId = ctx.db.normalizeId("posts", args.postId);
  if (postId === null) {
    return null;
  }
  const post = await ctx.db.get("posts", postId);
  if (post === null) {
    return null;
  }
  if (args.userId === undefined && args.zernioProfileId === undefined) {
    return post;
  }
  const zernioProfileId = await lookupProfileId(ctx, args);
  return post.zernioProfileId === zernioProfileId ? post : null;
}

async function findDuplicatePost(
  ctx: QueryCtx,
  args: {
    zernioProfileId: string;
    idempotencyKey: string;
    explicitKey: boolean;
  },
): Promise<Doc<"posts"> | null> {
  const existing = await ctx.db
    .query("posts")
    .withIndex("by_profile_idempotencyKey", (q) =>
      q
        .eq("zernioProfileId", args.zernioProfileId)
        .eq("idempotencyKey", args.idempotencyKey),
    )
    .order("desc")
    .first();
  if (existing === null || args.explicitKey) {
    return existing;
  }
  // A derived key means "this looks like a retry", not "this content was ever
  // posted": once the post it created has settled and the retry window closed,
  // the same content must be schedulable again.
  if (existing.status === "cancelled") {
    return null;
  }
  if (UNRESOLVED_STATUSES.includes(existing.status)) {
    return existing;
  }
  return existing._creationTime >= Date.now() - DERIVED_KEY_WINDOW_MS
    ? existing
    : null;
}

async function resolvePlatformTargets(
  ctx: QueryCtx,
  args: { zernioProfileId: string; accountIds: string[] },
): Promise<PlatformTarget[]> {
  const targets: PlatformTarget[] = [];
  for (const accountId of args.accountIds) {
    const account = await ctx.db
      .query("accounts")
      .withIndex("by_zernioAccountId", (q) =>
        q.eq("zernioAccountId", accountId),
      )
      .first();
    // An account on another profile is reported as unknown on purpose: the two
    // must be indistinguishable, or this is a cross-tenant account probe.
    if (account === null || account.zernioProfileId !== args.zernioProfileId) {
      throw new ConvexError({
        kind: "zernio_unknown_account",
        message: `Unknown Zernio account ${accountId}. Call syncAccounts() first: Zernio needs a platform for every accountId.`,
      });
    }
    targets.push({
      platform: account.platform,
      accountId,
      status: "pending" as const,
    });
  }
  return targets;
}

/**
 * Drops the stored body of expired webhook events, a bounded batch per incoming
 * delivery. The rows stay: `by_eventId` is the replay guard, so deleting them
 * would let an old redelivery apply twice.
 */
async function prunePayloads(ctx: MutationCtx, now: number): Promise<void> {
  const expiresBefore = now - PAYLOAD_RETENTION_MS;
  const state = await ctx.db.query("maintenance").first();
  const prunedThrough = state?.prunedThrough ?? 0;
  if (prunedThrough >= expiresBefore) {
    return;
  }
  const expired = await ctx.db
    .query("postEvents")
    .withIndex("by_receivedAt", (q) =>
      q.gte("receivedAt", prunedThrough).lt("receivedAt", expiresBefore),
    )
    .take(PAYLOAD_PRUNE_BATCH);
  // Nothing expired: leave the cursor alone. Writing it on every delivery would
  // turn this single row into a contention point for no gain.
  if (expired.length === 0) {
    return;
  }
  for (const row of expired) {
    if (row.payload !== undefined) {
      await ctx.db.patch("postEvents", row._id, { payload: undefined });
    }
  }
  // The cursor is what keeps this O(batch) per delivery: without it every
  // delivery would re-scan the rows it already pruned.
  const next =
    expired.length === PAYLOAD_PRUNE_BATCH
      ? expired[expired.length - 1].receivedAt + 1
      : expiresBefore;
  if (state === null) {
    await ctx.db.insert("maintenance", { prunedThrough: next });
    return;
  }
  await ctx.db.patch("maintenance", state._id, { prunedThrough: next });
}

async function storeOptions(
  ctx: MutationCtx,
  options: RuntimeOptions,
): Promise<void> {
  const existing = await ctx.db.query("lastOptions").first();
  if (existing === null) {
    await ctx.db.insert("lastOptions", { options });
    return;
  }
  // Only write on a real change: every public function persists options, and a
  // no-op write would make the single row a contention point.
  if (
    existing.options.baseUrl === options.baseUrl &&
    existing.options.testMode === options.testMode &&
    existing.options.onPostEvent === options.onPostEvent &&
    existing.options.onAccountEvent === options.onAccountEvent
  ) {
    return;
  }
  await ctx.db.patch("lastOptions", existing._id, { options });
}

async function readOptions(ctx: QueryCtx): Promise<RuntimeOptions | null> {
  const row = await ctx.db.query("lastOptions").first();
  return row?.options ?? null;
}

async function consumeApiToken(ctx: ActionCtx, key: string): Promise<void> {
  const limit = await rateLimiter.limit(ctx, "zernioApi", { key });
  if (!limit.ok) {
    throw new ConvexError({
      kind: "zernio_rate_limited",
      retryAfter: limit.retryAfter,
      message: `Zernio API rate limit reached, retry in ${Math.ceil(limit.retryAfter / 1000)}s`,
    });
  }
}

async function ensureProfileId(
  ctx: ActionCtx,
  args: {
    options: RuntimeOptions;
    apiKey: string;
    userId?: string;
    zernioProfileId?: string;
    profileName?: string;
  },
): Promise<string> {
  if (args.userId === undefined) {
    if (args.zernioProfileId === undefined) {
      throw new ConvexError({
        kind: "zernio_no_profile",
        message:
          "No Zernio profile: pass options.profileId or ZERNIO_PROFILE_ID.",
      });
    }
    return args.zernioProfileId;
  }
  const existing: string | null = await ctx.runQuery(
    internal.lib.getProfileIdForUser,
    { userId: args.userId },
  );
  if (existing !== null) {
    return existing;
  }
  const created = await createZernioProfile(ctx, {
    options: args.options,
    apiKey: args.apiKey,
    userId: args.userId,
    profileName: args.profileName,
  });
  // Written separately so a crash before the write leaves the Idempotency-Key
  // to make the retry safe.
  return await ctx.runMutation(internal.lib.upsertProfileMapping, {
    userId: args.userId,
    zernioProfileId: created,
  });
}

async function createZernioProfile(
  ctx: ActionCtx,
  args: {
    options: RuntimeOptions;
    apiKey: string;
    userId: string;
    profileName?: string;
  },
): Promise<string> {
  const name = args.profileName ?? `user:${args.userId}`;
  await consumeApiToken(ctx, args.userId);
  const response = await zernioFetch({
    baseUrl: args.options.baseUrl,
    apiKey: args.apiKey,
    method: "POST",
    path: "/v1/profiles",
    headers: { "Idempotency-Key": `zernio-convex-profile-${args.userId}` },
    body: {
      name,
      description: `Created by @zernio/convex for app user ${args.userId}`,
    },
  });
  if (response.ok) {
    const created = readString(readRecord(response.data, "profile"), "_id");
    if (created !== null) {
      return created;
    }
    throw new ConvexError({
      kind: "zernio_api_error",
      status: response.status,
      message: "Zernio profile response carried no profile._id",
    });
  }
  if (response.status === 409) {
    const existing = readString(
      readRecord(response.data, "details"),
      "existingProfileId",
    );
    return existing ?? (await findProfileIdByName(ctx, { ...args, name }));
  }
  throw zernioApiError(response, "Failed to create the Zernio profile");
}

async function findProfileIdByName(
  ctx: ActionCtx,
  args: {
    options: RuntimeOptions;
    apiKey: string;
    userId: string;
    name: string;
  },
): Promise<string> {
  await consumeApiToken(ctx, args.userId);
  const response = await zernioFetch({
    baseUrl: args.options.baseUrl,
    apiKey: args.apiKey,
    method: "GET",
    path: "/v1/profiles",
    query: { name: args.name },
  });
  if (!response.ok) {
    throw zernioApiError(response, "Failed to look up the Zernio profile");
  }
  const profiles = readArray(response.data, "profiles");
  const only = profiles.length === 1 ? readString(profiles[0], "_id") : null;
  if (only === null) {
    throw new ConvexError({
      kind: "zernio_profile_ambiguous",
      message: `Could not resolve a single Zernio profile named ${args.name}`,
    });
  }
  return only;
}

/**
 * Undoes a create that a cancel raced. `cancelPost` cannot recall an in-flight
 * `POST /v1/posts`, so the post Zernio just accepted is deleted here: without
 * it a cancelled post stays scheduled and publishes anyway. Best effort by
 * design, the id stays on the row so the app can retry through `request()`.
 */
async function deleteRacedPost(
  ctx: ActionCtx,
  args: {
    options: RuntimeOptions;
    apiKey: string;
    zernioProfileId: string;
    zernioPostId: string;
  },
): Promise<void> {
  try {
    await consumeApiToken(ctx, args.zernioProfileId);
    await zernioFetch({
      baseUrl: args.options.baseUrl,
      apiKey: args.apiKey,
      method: "DELETE",
      path: `/v1/posts/${args.zernioPostId}`,
    });
  } catch {
    return;
  }
}

function isSameSubmission(entry: unknown, post: Doc<"posts">): boolean {
  if (readString(entry, "content") !== post.content) {
    return false;
  }
  const createdAt = parseTimestamp(readString(entry, "createdAt"));
  const submittedAt = post.submittedAt ?? post._creationTime;
  if (createdAt === null || createdAt < submittedAt - RECONCILE_SLACK_MS) {
    return false;
  }
  const accountIds = new Set(
    readArray(entry, "platforms").flatMap((target) => {
      const accountId = normalizeZernioId(
        isRecord(target) ? target.accountId : null,
      );
      return accountId !== null ? [accountId] : [];
    }),
  );
  return (
    accountIds.size === post.accountIds.length &&
    post.accountIds.every((accountId) => accountIds.has(accountId))
  );
}

/**
 * Looks for the post a previous attempt may have created before it failed.
 * Returns `null` when Zernio holds no such post, which is the only case where
 * re-POSTing is safe. Throws (retryable) when the lookup itself fails: guessing
 * would risk publishing the same content twice.
 */
async function reconcileSubmission(
  ctx: ActionCtx,
  args: { post: Doc<"posts">; options: RuntimeOptions; apiKey: string },
): Promise<{ zernioPostId: string; status: PostStatus } | null> {
  const { post } = args;
  await consumeApiToken(ctx, post.zernioProfileId);
  const response = await zernioFetch({
    baseUrl: args.options.baseUrl,
    apiKey: args.apiKey,
    method: "GET",
    path: "/v1/posts",
    query: {
      profileId: post.zernioProfileId,
      limit: "50",
      sortBy: "created-desc",
    },
  });
  if (!response.ok) {
    throw new Error(
      zernioErrorMessage(
        response,
        `Could not check whether attempt ${post.submitAttempts ?? 1} of post ${post._id} already reached Zernio`,
      ),
    );
  }
  const match = readArray(response.data, "posts").find((entry) =>
    isSameSubmission(entry, post),
  );
  const zernioPostId = match !== undefined ? readString(match, "_id") : null;
  if (zernioPostId === null) {
    return null;
  }
  const owner: Doc<"posts"> | null = await ctx.runQuery(
    internal.lib.getPostByZernioId,
    { zernioPostId },
  );
  if (owner !== null && owner._id !== post._id) {
    return null;
  }
  const status =
    mapZernioPostStatus(readString(match, "status")) ??
    (post.scheduledFor !== undefined ? "scheduled" : "published");
  const platforms = platformTargetsFrom(
    readArray(match, "platforms"),
    post.platforms,
  );
  const recorded = await ctx.runMutation(internal.lib.recordSubmission, {
    postId: post._id,
    zernioPostId,
    status,
    platforms,
    finalized: isTerminalPostStatus(status),
  });
  if (recorded.cancelled) {
    await deleteRacedPost(ctx, {
      options: args.options,
      apiKey: args.apiKey,
      zernioProfileId: post.zernioProfileId,
      zernioPostId,
    });
  }
  return { zernioPostId, status };
}

async function recordCreateResponse(
  ctx: ActionCtx,
  args: {
    post: Doc<"posts">;
    response: ZernioResponse;
    options: RuntimeOptions;
    apiKey: string;
  },
): Promise<{ zernioPostId: string | null; status: PostStatus }> {
  const { post, response } = args;
  const testMode = args.options.testMode;
  const undoIfCancelled = async (
    result: { cancelled: boolean },
    zernioPostId: string,
  ): Promise<void> => {
    if (result.cancelled) {
      await deleteRacedPost(ctx, {
        options: args.options,
        apiKey: args.apiKey,
        zernioProfileId: post.zernioProfileId,
        zernioPostId,
      });
    }
  };
  // 202 is an idempotent replay still in flight: it carries postId, not post.
  if (response.status === 202) {
    const zernioPostId = readString(response.data, "postId");
    if (zernioPostId === null) {
      throw new Error("Zernio 202 response carried no postId");
    }
    const recorded = await ctx.runMutation(internal.lib.recordSubmission, {
      postId: post._id,
      zernioPostId,
      status: "submitting",
      platforms: post.platforms,
      finalized: false,
    });
    await undoIfCancelled(recorded, zernioPostId);
    return { zernioPostId, status: "submitting" };
  }
  if (response.ok) {
    const created = readRecord(response.data, "post");
    const zernioPostId = readString(created, "_id");
    if (zernioPostId === null) {
      throw new Error("Zernio create response carried no post._id");
    }
    const platforms = platformTargetsFrom(
      readArray(created, "platforms"),
      post.platforms,
    );
    const status = testMode
      ? ("draft" as const)
      : (mapZernioPostStatus(readString(created, "status")) ??
        (post.scheduledFor !== undefined ? "scheduled" : "published"));
    // 207 carries a top-level error alongside the post.
    const errorMessage = readString(response.data, "error");
    const recorded = await ctx.runMutation(internal.lib.recordSubmission, {
      postId: post._id,
      zernioPostId,
      status,
      platforms,
      ...(errorMessage !== null ? { errorMessage } : {}),
      finalized: isTerminalPostStatus(status),
    });
    await undoIfCancelled(recorded, zernioPostId);
    return { zernioPostId, status };
  }
  if (response.status === 409) {
    // Content dedup: Zernio already holds an equivalent post, so adopt it,
    // unless another row already owns that id. Two rows pointing at one Zernio
    // post is worse than a failure: webhooks would only ever reach one of them,
    // and cancelling either would delete the other's live post.
    const existingPostId = readString(
      readRecord(response.data, "details"),
      "existingPostId",
    );
    if (existingPostId !== null) {
      const owner: Doc<"posts"> | null = await ctx.runQuery(
        internal.lib.getPostByZernioId,
        { zernioPostId: existingPostId },
      );
      if (owner === null || owner._id === post._id) {
        await ctx.runMutation(internal.lib.recordSubmission, {
          postId: post._id,
          zernioPostId: existingPostId,
          status: "scheduled",
          platforms: post.platforms,
          finalized: false,
        });
        return { zernioPostId: existingPostId, status: "scheduled" };
      }
      const message = `Zernio rejected this post as duplicate content of ${existingPostId}, which post ${owner._id} already owns. Change the content or cancel the other post.`;
      await ctx.runMutation(internal.lib.recordSubmissionFailure, {
        postId: post._id,
        errorMessage: message,
      });
      throw new NonRetryableError(message);
    }
  }
  if (isPermanentFailure(response.status)) {
    const message = zernioErrorMessage(
      response,
      `Zernio rejected the post with status ${response.status}`,
    );
    await ctx.runMutation(internal.lib.recordSubmissionFailure, {
      postId: post._id,
      errorMessage: message,
    });
    throw new NonRetryableError(message);
  }
  const retryAfter =
    response.retryAfter !== null
      ? ` (retry-after: ${response.retryAfter})`
      : "";
  throw new Error(
    `${zernioErrorMessage(response, `Zernio returned ${response.status}`)}${retryAfter}`,
  );
}

type WebhookArgs = {
  options: RuntimeOptions | null;
  eventId: string;
  event: string;
  payload: unknown;
  receivedAt: number;
};

type WebhookResult = {
  deduped: boolean;
  applied: boolean;
  postId: Doc<"posts">["_id"] | null;
  accountId: Doc<"accounts">["_id"] | null;
};

/**
 * A settled post never goes back to being in flight. Zernio fires
 * `post.scheduled` at create time, so it can arrive after the app cancelled the
 * post and after the component deleted it in Zernio; without this the row would
 * read `scheduled` forever for a post that no longer exists. One terminal state
 * may still correct another (a `post.published` that beat the cancel's delete is
 * the truth), so only the move back to a non-terminal status is refused.
 */
function isDemotion(current: PostStatus, next: PostStatus | null): boolean {
  if (next === null || next === current) {
    return false;
  }
  return isTerminalPostStatus(current) && !isTerminalPostStatus(next);
}

async function applyPostEvent(
  ctx: MutationCtx,
  args: WebhookArgs,
): Promise<WebhookResult> {
  const zernioPostId = postProjectionId(args.payload);
  const eventAt =
    parseTimestamp(readString(args.payload, "timestamp")) ?? args.receivedAt;
  const platform = isPlatformEvent(args.event)
    ? readString(readRecord(args.payload, "platform"), "name")
    : null;
  if (zernioPostId === null) {
    await ctx.db.insert("postEvents", {
      event: args.event,
      eventId: args.eventId,
      receivedAt: args.receivedAt,
      payload: args.payload,
    });
    return { deduped: false, applied: false, postId: null, accountId: null };
  }
  const post = await ctx.db
    .query("posts")
    .withIndex("by_zernioPostId", (q) => q.eq("zernioPostId", zernioPostId))
    .first();
  let platforms = platformTargetsFrom(
    postProjectionPlatforms(args.payload),
    post?.platforms ?? [],
  );
  if (isPlatformEvent(args.event)) {
    platforms = applyPlatformBlock({
      targets: platforms,
      payload: args.payload,
      event: args.event,
      eventAt,
    });
  }
  const transition = postTransitionFor(args.event, args.payload);
  const inOrder =
    post !== null &&
    (post.lastEventAt === undefined || eventAt >= post.lastEventAt) &&
    !isDemotion(post.status, transition.status);
  const errorMessage = firstPlatformError(platforms);
  let status: PostStatus =
    post?.status ??
    transition.status ??
    mapZernioPostStatus(
      readString(readRecord(args.payload, "post"), "status"),
    ) ??
    "pending";
  if (post !== null && inOrder) {
    status = transition.status ?? post.status;
    await ctx.db.patch("posts", post._id, {
      status,
      platforms,
      lastEventAt: eventAt,
      ...(errorMessage !== null ? { errorMessage } : {}),
      ...(transition.finalized ? { finalizedAt: eventAt } : {}),
    });
  }
  await ctx.db.insert("postEvents", {
    postId: post?._id,
    zernioPostId,
    event: args.event,
    platform: platform ?? undefined,
    eventId: args.eventId,
    receivedAt: args.receivedAt,
    payload: args.payload,
  });
  if (args.options?.onPostEvent !== undefined) {
    await ctx.runMutation(
      // A FunctionHandle is a branded string; the app created it from its own
      // internal mutation reference.
      args.options.onPostEvent as FunctionHandle<"mutation", PostEventArgs>,
      {
        eventId: args.eventId,
        event: args.event,
        postId: post?._id ?? null,
        zernioPostId,
        status,
        platform,
        platforms,
        errorMessage,
        receivedAt: args.receivedAt,
        payload: args.payload,
      },
    );
  }
  return {
    deduped: false,
    applied: post !== null && inOrder,
    postId: post?._id ?? null,
    accountId: null,
  };
}

async function applyAccountEvent(
  ctx: MutationCtx,
  args: WebhookArgs,
): Promise<WebhookResult> {
  const block = accountBlockFrom(args.payload);
  if (block === null) {
    await ctx.db.insert("postEvents", {
      event: args.event,
      eventId: args.eventId,
      receivedAt: args.receivedAt,
      payload: args.payload,
    });
    return { deduped: false, applied: false, postId: null, accountId: null };
  }
  const isActive = args.event === "account.connected";
  const eventAt =
    parseTimestamp(readString(args.payload, "timestamp")) ?? args.receivedAt;
  const existing = await ctx.db
    .query("accounts")
    .withIndex("by_zernioAccountId", (q) =>
      q.eq("zernioAccountId", block.zernioAccountId),
    )
    .first();
  // Delivery is at-least-once and unordered, so a redelivered `account.connected`
  // must not reactivate an account the user has since disconnected.
  const inOrder =
    existing === null ||
    existing.lastEventAt === undefined ||
    eventAt >= existing.lastEventAt;
  const accountId = inOrder
    ? await upsertAccount(ctx, {
        zernioAccountId: block.zernioAccountId,
        zernioProfileId: block.zernioProfileId,
        platform: block.platform,
        username: block.username,
        ...(block.displayName !== null
          ? { displayName: block.displayName }
          : {}),
        isActive,
        syncedAt: args.receivedAt,
        lastEventAt: eventAt,
      })
    : existing._id;
  await ctx.db.insert("postEvents", {
    event: args.event,
    platform: block.platform,
    eventId: args.eventId,
    receivedAt: args.receivedAt,
    payload: args.payload,
  });
  if (args.options?.onAccountEvent !== undefined) {
    await ctx.runMutation(
      args.options.onAccountEvent as FunctionHandle<
        "mutation",
        AccountEventArgs
      >,
      {
        eventId: args.eventId,
        event: args.event,
        accountId,
        zernioAccountId: block.zernioAccountId,
        zernioProfileId: block.zernioProfileId,
        platform: block.platform,
        username: block.username,
        displayName: block.displayName,
        isActive,
        disconnectionType: block.disconnectionType,
        reason: block.reason,
        receivedAt: args.receivedAt,
        payload: args.payload,
      },
    );
  }
  return { deduped: false, applied: inOrder, postId: null, accountId };
}
