import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { vPlatformTarget, vPostStatus, vRuntimeOptions } from "./shared.js";

export default defineSchema({
  profiles: defineTable({
    userId: v.string(),
    zernioProfileId: v.string(),
  })
    .index("by_userId", ["userId"])
    .index("by_zernioProfileId", ["zernioProfileId"]),

  accounts: defineTable({
    zernioAccountId: v.string(),
    zernioProfileId: v.string(),
    platform: v.string(),
    username: v.string(),
    displayName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    isActive: v.boolean(),
    syncedAt: v.number(),
    // Newest applied webhook envelope timestamp. Separate from syncedAt, which
    // runs off the sync clock and would make the comparison meaningless.
    lastEventAt: v.optional(v.number()),
  })
    .index("by_zernioAccountId", ["zernioAccountId"])
    .index("by_profile", ["zernioProfileId", "platform"]),

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
    // How many times the submit job has run. Anything past the first attempt
    // reconciles with Zernio before it would POST again, because a previous
    // attempt may have created the post before it failed.
    submitAttempts: v.optional(v.number()),
    // Newest applied webhook envelope timestamp: delivery is unordered, so
    // post-level writes are last-write-wins on it.
    lastEventAt: v.optional(v.number()),
  })
    .index("by_zernioPostId", ["zernioPostId"])
    .index("by_profile_idempotencyKey", ["zernioProfileId", "idempotencyKey"])
    .index("by_profile_creation", ["zernioProfileId"])
    .index("by_profile_status", ["zernioProfileId", "status"]),

  postEvents: defineTable({
    postId: v.optional(v.id("posts")),
    zernioPostId: v.optional(v.string()),
    event: v.string(),
    platform: v.optional(v.string()),
    eventId: v.string(),
    receivedAt: v.number(),
    // Dropped once the row ages past the payload retention window. The row
    // itself is kept forever, so replay dedup never weakens.
    payload: v.optional(v.any()),
  })
    .index("by_postId", ["postId"])
    .index("by_eventId", ["eventId"])
    .index("by_receivedAt", ["receivedAt"]),

  lastOptions: defineTable({
    options: vRuntimeOptions,
  }),

  // Cursor for the incremental payload prune, so it never rescans what it
  // already cleared.
  maintenance: defineTable({
    prunedThrough: v.number(),
  }),
});
