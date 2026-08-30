import { vAccountEventArgs, vPostEventArgs, Zernio } from "@zernio/convex";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import {
  action,
  internalMutation,
  mutation,
  query,
} from "./_generated/server.js";

/**
 * SINGLE-TENANT MODE (what this example runs).
 *
 * No `getUserInfo`, so every call uses `options.profileId ?? ZERNIO_PROFILE_ID`
 * as the Zernio profile. `apiKey` and `webhookSecret` come from
 * ZERNIO_API_KEY and ZERNIO_WEBHOOK_SECRET, read on every call.
 *
 * `testMode` is left at its default of TRUE: every post is created as a Zernio
 * DRAFT and never reaches an audience. Pass `testMode: false` below to publish
 * for real.
 */
export const zernio = new Zernio(components.zernio, {
  onPostEvent: internal.example.onPostEvent,
  onAccountEvent: internal.example.onAccountEvent,
});

/**
 * MULTI-TENANT MODE (commented out).
 *
 * Supplying `getUserInfo` switches the component to one Zernio profile per app
 * user: the component keeps the app userId -> Zernio profileId mapping and
 * creates the profile on the user's first `connectAccountUrl` or
 * `syncAccounts`. ZERNIO_PROFILE_ID is then unused.
 *
 * In that mode you do not need the wrappers below at all. `zernio.api()`
 * returns the same eight functions, each resolving the caller through
 * `getUserInfo` and scoped to that user, so the whole public surface is one
 * destructuring:
 *
 * ```ts
 * export const zernio = new Zernio(components.zernio, {
 *   getUserInfo: async (ctx) => {
 *     const identity = await ctx.auth.getUserIdentity();
 *     if (identity === null) {
 *       throw new Error("Not signed in");
 *     }
 *     return { userId: identity.subject, email: identity.email };
 *   },
 *   onPostEvent: internal.example.onPostEvent,
 *   onAccountEvent: internal.example.onAccountEvent,
 * });
 *
 * export const {
 *   listAccounts,
 *   listPosts,
 *   getPost,
 *   status,
 *   schedulePost,
 *   cancelPost,
 *   connectAccountUrl,
 *   syncAccounts,
 * } = zernio.api();
 * ```
 *
 * `api()` throws without `getUserInfo` on purpose: those functions are public
 * and reachable from a browser, so they must resolve the caller themselves.
 * A single-tenant app has no caller to resolve, so it wraps the class methods
 * in its own functions instead, which is what the rest of this file does.
 */

export const listAccounts = query({
  args: {},
  handler: async (ctx) => await zernio.listAccounts(ctx),
});

export const listPosts = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => await zernio.listPosts(ctx, args),
});

// Reads are scoped to the configured profile, so a post id from another profile
// reads as unknown. That is what makes the same wrappers safe to expose.
export const getPost = query({
  args: { postId: v.string() },
  handler: async (ctx, args) => await zernio.getPost(ctx, args.postId),
});

// The query the UI subscribes to per post. Every webhook Zernio delivers
// invalidates it, so the browser re-renders without polling.
export const status = query({
  args: { postId: v.string() },
  handler: async (ctx, args) => await zernio.status(ctx, args.postId),
});

export const schedulePost = mutation({
  args: {
    accountIds: v.array(v.string()),
    content: v.string(),
    scheduledFor: v.optional(v.number()),
    title: v.optional(v.string()),
    mediaUrls: v.optional(v.array(v.string())),
    timezone: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => await zernio.schedulePost(ctx, args),
});

export const cancelPost = action({
  args: { postId: v.string() },
  handler: async (ctx, args) => await zernio.cancelPost(ctx, args.postId),
});

export const connectAccountUrl = action({
  args: { platform: v.string(), redirectUrl: v.optional(v.string()) },
  handler: async (ctx, args) => await zernio.connectAccountUrl(ctx, args),
});

export const syncAccounts = action({
  args: {},
  handler: async (ctx) => await zernio.syncAccounts(ctx),
});

// Callbacks run INSIDE the component's webhook transaction: this row and the
// component's state change commit together, or neither does.
export const onPostEvent = internalMutation({
  args: vPostEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("postEventLog", {
      eventId: args.eventId,
      event: args.event,
      postId: args.postId,
      zernioPostId: args.zernioPostId,
      status: args.status,
      platform: args.platform,
      errorMessage: args.errorMessage,
      receivedAt: args.receivedAt,
    });
    return null;
  },
});

export const onAccountEvent = internalMutation({
  args: vAccountEventArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("accountEventLog", {
      eventId: args.eventId,
      event: args.event,
      zernioAccountId: args.zernioAccountId,
      platform: args.platform,
      username: args.username,
      isActive: args.isActive,
      receivedAt: args.receivedAt,
    });
    return null;
  },
});

export const postEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    await ctx.db
      .query("postEventLog")
      .order("desc")
      .take(args.limit ?? 25),
});

export const accountEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) =>
    await ctx.db
      .query("accountEventLog")
      .order("desc")
      .take(args.limit ?? 25),
});

// Everything Zernio exposes beyond posts and accounts goes through the escape
// hatch: one typed call, no component function to mount. A non-2xx does not
// throw, so read `ok` and `data`.
export const usageStats = action({
  args: {},
  handler: async (ctx) =>
    await zernio.request(ctx, { method: "GET", path: "/v1/usage-stats" }),
});
