import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // The app's own record of what the component told it. These rows are written
  // inside the component's webhook transaction, so a row here exists if and
  // only if the component applied the matching event.
  postEventLog: defineTable({
    eventId: v.string(),
    event: v.string(),
    postId: v.union(v.null(), v.string()),
    zernioPostId: v.string(),
    status: v.string(),
    platform: v.union(v.null(), v.string()),
    errorMessage: v.union(v.null(), v.string()),
    receivedAt: v.number(),
  }),
  accountEventLog: defineTable({
    eventId: v.string(),
    event: v.string(),
    zernioAccountId: v.string(),
    platform: v.string(),
    username: v.string(),
    isActive: v.boolean(),
    receivedAt: v.number(),
  }),
});
