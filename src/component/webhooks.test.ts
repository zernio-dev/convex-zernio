/// <reference types="vite/client" />

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import {
  apiKey,
  initConvexTest,
  jsonResponse,
  liveOptions,
  options,
  profileId,
  schedule,
  seedAccounts,
  stubFetch,
  type TestConvexInstance,
} from "./setup.test.js";

describe("handleWebhookEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function scheduledPost(
    t: TestConvexInstance,
    accountIds: string[] = ["acc_x"],
  ) {
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false, accountIds });
    const platforms = accountIds.map((accountId) => ({
      platform: accountId === "acc_ig" ? "instagram" : "twitter",
      accountId,
      status: "pending",
    }));
    stubFetch(
      jsonResponse(201, {
        post: { _id: "zpost_1", status: "scheduled", platforms },
      }),
    );
    await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });
    return postId;
  }

  test("applies post.published and dedupes the replay", async () => {
    const t = initConvexTest();
    const postId = await scheduledPost(t);
    const payload = {
      id: "evt_1",
      event: "post.published",
      timestamp: "2026-08-30T10:00:00.000Z",
      post: {
        id: "zpost_1",
        content: "hello world",
        status: "published",
        scheduledFor: "2026-08-30T09:00:00.000Z",
        platforms: [
          {
            platform: "twitter",
            accountId: "acc_x",
            status: "published",
            platformPostId: "1",
            publishedUrl: "https://x.com/acme/1",
          },
        ],
      },
    };

    const first = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_1",
      event: "post.published",
      payload,
    });
    const replay = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_1",
      event: "post.published",
      payload,
    });

    expect(first).toMatchObject({ deduped: false, applied: true, postId });
    expect(replay).toMatchObject({ deduped: true, applied: false, postId });
    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("published");
    expect(summary?.platforms[0].publishedUrl).toBe("https://x.com/acme/1");
  });

  test("an out-of-order post.scheduled does not regress a published post", async () => {
    const t = initConvexTest();
    const postId = await scheduledPost(t);
    await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_published",
      event: "post.published",
      payload: {
        id: "evt_published",
        event: "post.published",
        timestamp: "2026-08-30T10:00:00.000Z",
        post: { id: "zpost_1", status: "published", platforms: [] },
      },
    });

    const late = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_scheduled",
      event: "post.scheduled",
      payload: {
        id: "evt_scheduled",
        event: "post.scheduled",
        timestamp: "2026-08-30T09:00:00.000Z",
        post: { id: "zpost_1", status: "scheduled", platforms: [] },
      },
    });

    expect(late.applied).toBe(false);
    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("published");
  });

  test("a platform failure records the error without finalizing the post", async () => {
    const t = initConvexTest();
    const postId = await scheduledPost(t);

    await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_platform",
      event: "post.platform.failed",
      payload: {
        id: "evt_platform",
        event: "post.platform.failed",
        timestamp: "2026-08-30T10:00:00.000Z",
        post: {
          id: "zpost_1",
          status: "publishing",
          platforms: [
            { platform: "twitter", accountId: "acc_x", status: "failed" },
          ],
        },
        platform: {
          name: "twitter",
          status: "failed",
          error: "Duplicate tweet",
        },
        account: { accountId: "acc_x", platform: "twitter", username: "@acme" },
      },
    });

    const summary = await t.query(api.lib.getPostStatus, { postId });
    // "publishing" is still in flight, so the post keeps its own status.
    expect(summary?.status).toBe("scheduled");
    expect(summary?.platforms[0]).toMatchObject({
      status: "failed",
      errorMessage: "Duplicate tweet",
    });
    expect(summary?.errorMessage).toBe("Duplicate tweet");
  });

  test("account.disconnected deactivates the stored account", async () => {
    const t = initConvexTest();
    await seedAccounts(t);

    const result = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_account",
      event: "account.disconnected",
      payload: {
        id: "evt_account",
        event: "account.disconnected",
        timestamp: "2026-08-30T10:00:00.000Z",
        account: {
          accountId: "acc_x",
          profileId,
          platform: "twitter",
          username: "@acme",
          disconnectionType: "unintentional",
          reason: "Token expired or revoked",
        },
      },
    });

    expect(result.applied).toBe(true);
    const accounts = await t.query(api.lib.listAccounts, {
      zernioProfileId: profileId,
      platform: "twitter",
    });
    expect(accounts[0].isActive).toBe(false);
  });

  test("a late post.scheduled cannot resurrect a cancelled post", async () => {
    const t = initConvexTest();
    const postId = await scheduledPost(t);
    stubFetch(jsonResponse(200, { message: "deleted" }));
    await t.action(api.lib.cancelPost, {
      options: liveOptions,
      apiKey,
      postId,
    });

    // Zernio fires post.scheduled at create time, so it can land after the
    // cancel and after the post was deleted on their side.
    const late = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_scheduled_late",
      event: "post.scheduled",
      payload: {
        id: "evt_scheduled_late",
        event: "post.scheduled",
        timestamp: "2026-08-30T10:00:00.000Z",
        post: { id: "zpost_1", status: "scheduled", platforms: [] },
      },
    });

    expect(late.applied).toBe(false);
    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("cancelled");
  });

  test("a redelivered account.connected does not undo a later disconnect", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const connected = (eventId: string) => ({
      options,
      eventId,
      event: "account.connected" as const,
      payload: {
        id: eventId,
        event: "account.connected",
        timestamp: "2026-08-30T10:00:00.000Z",
        account: {
          accountId: "acc_x",
          profileId,
          platform: "twitter",
          username: "@acme",
        },
      },
    });
    await t.mutation(api.lib.handleWebhookEvent, connected("evt_connect"));
    await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_disconnect",
      event: "account.disconnected",
      payload: {
        id: "evt_disconnect",
        event: "account.disconnected",
        timestamp: "2026-08-30T10:02:00.000Z",
        account: {
          accountId: "acc_x",
          profileId,
          platform: "twitter",
          username: "@acme",
          disconnectionType: "intentional",
        },
      },
    });

    // The retry of the 10:00 connect lands at 10:05.
    const replay = await t.mutation(
      api.lib.handleWebhookEvent,
      connected("evt_connect_retry"),
    );

    expect(replay.applied).toBe(false);
    const accounts = await t.query(api.lib.listAccounts, {
      zernioProfileId: profileId,
      platform: "twitter",
    });
    expect(accounts[0].isActive).toBe(false);
  });

  test("drops the stored body of events past the retention window", async () => {
    const t = initConvexTest();
    const now = Date.now();
    const payload = {
      id: "evt_old",
      event: "post.published",
      timestamp: "2026-07-01T10:00:00.000Z",
      post: { id: "zpost_gone", status: "published", platforms: [] },
    };
    await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_old",
      event: "post.published",
      payload,
      receivedAt: now - 40 * 24 * 60 * 60 * 1000,
    });

    await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_new",
      event: "post.published",
      payload: { ...payload, id: "evt_new" },
      receivedAt: now,
    });

    const rows = await t.run(async (ctx) =>
      await ctx.db.query("postEvents").collect(),
    );
    const stored = new Map(rows.map((row) => [row.eventId, row]));
    expect(stored.get("evt_old")?.payload).toBeUndefined();
    expect(stored.get("evt_new")?.payload).toMatchObject({ id: "evt_new" });
    // The row itself stays, so the replay guard never weakens.
    expect(
      await t.mutation(api.lib.handleWebhookEvent, {
        options,
        eventId: "evt_old",
        event: "post.published",
        payload,
      }),
    ).toMatchObject({ deduped: true });
  });

  test("ignores an event the component does not consume", async () => {
    const t = initConvexTest();
    const result = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_test",
      event: "webhook.test",
      payload: { id: "evt_test", event: "webhook.test" },
    });
    expect(result).toEqual({
      deduped: false,
      applied: false,
      postId: null,
      accountId: null,
    });
  });

  test("post.failed finalizes the post with the platform's error", async () => {
    const t = initConvexTest();
    const postId = await scheduledPost(t);

    await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_failed",
      event: "post.failed",
      payload: {
        id: "evt_failed",
        event: "post.failed",
        timestamp: "2026-08-30T10:00:00.000Z",
        post: {
          id: "zpost_1",
          status: "failed",
          platforms: [
            {
              platform: "twitter",
              accountId: "acc_x",
              status: "failed",
              error: "Duplicate tweet",
            },
          ],
        },
      },
    });

    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("failed");
    expect(summary?.errorMessage).toBe("Duplicate tweet");
    expect(summary?.finalizedAt).toBe(Date.parse("2026-08-30T10:00:00.000Z"));
    expect(summary?.platforms[0].status).toBe("failed");
  });

  test("post.partial splits the per-platform statuses and finalizes", async () => {
    const t = initConvexTest();
    const postId = await scheduledPost(t, ["acc_x", "acc_ig"]);

    const result = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_partial",
      event: "post.partial",
      payload: {
        id: "evt_partial",
        event: "post.partial",
        timestamp: "2026-08-30T10:00:00.000Z",
        post: {
          id: "zpost_1",
          status: "partial",
          platforms: [
            {
              platform: "twitter",
              accountId: "acc_x",
              status: "published",
              platformPostId: "1",
              publishedUrl: "https://x.com/acme/1",
            },
            {
              platform: "instagram",
              accountId: "acc_ig",
              status: "failed",
              error: "Media download failed",
            },
          ],
        },
      },
    });

    expect(result).toMatchObject({ applied: true, postId });
    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("partial");
    expect(summary?.finalizedAt).toBe(Date.parse("2026-08-30T10:00:00.000Z"));
    expect(summary?.platforms).toEqual([
      {
        platform: "twitter",
        accountId: "acc_x",
        status: "published",
        platformPostId: "1",
        publishedUrl: "https://x.com/acme/1",
      },
      {
        platform: "instagram",
        accountId: "acc_ig",
        status: "failed",
        errorMessage: "Media download failed",
      },
    ]);
    expect(summary?.errorMessage).toBe("Media download failed");
  });

  test("post.platform.published fills one target and leaves the post scheduled", async () => {
    const t = initConvexTest();
    const postId = await scheduledPost(t, ["acc_x", "acc_ig"]);
    const eventAt = Date.parse("2026-08-30T10:00:00.000Z");

    await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_platform_ok",
      event: "post.platform.published",
      payload: {
        id: "evt_platform_ok",
        event: "post.platform.published",
        timestamp: "2026-08-30T10:00:00.000Z",
        post: {
          id: "zpost_1",
          status: "publishing",
          platforms: [
            { platform: "twitter", accountId: "acc_x", status: "published" },
            { platform: "instagram", accountId: "acc_ig", status: "pending" },
          ],
        },
        platform: {
          name: "twitter",
          status: "published",
          platformPostId: "1",
          publishedUrl: "https://x.com/acme/1",
        },
        account: { accountId: "acc_x", platform: "twitter", username: "@acme" },
      },
    });

    const summary = await t.query(api.lib.getPostStatus, { postId });
    // The rollup event is what finalizes a post, never a per-platform one.
    expect(summary?.status).toBe("scheduled");
    expect(summary?.finalizedAt).toBeNull();
    expect(summary?.platforms[0]).toEqual({
      platform: "twitter",
      accountId: "acc_x",
      status: "published",
      platformPostId: "1",
      publishedUrl: "https://x.com/acme/1",
      publishedAt: eventAt,
    });
    expect(summary?.platforms[1].status).toBe("pending");
  });

  test("records and dedupes an event for a post it never created", async () => {
    const t = initConvexTest();
    const payload = {
      id: "evt_foreign",
      event: "post.published",
      timestamp: "2026-08-30T10:00:00.000Z",
      post: { id: "zpost_elsewhere", status: "published", platforms: [] },
    };

    const first = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_foreign",
      event: "post.published",
      payload,
    });
    const replay = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_foreign",
      event: "post.published",
      payload,
    });

    expect(first).toEqual({
      deduped: false,
      applied: false,
      postId: null,
      accountId: null,
    });
    expect(replay.deduped).toBe(true);
  });

  test("account.connected stores an account for a profile never synced", async () => {
    const t = initConvexTest();

    const result = await t.mutation(api.lib.handleWebhookEvent, {
      options,
      eventId: "evt_connected",
      event: "account.connected",
      payload: {
        id: "evt_connected",
        event: "account.connected",
        timestamp: "2026-08-30T10:00:00.000Z",
        account: {
          accountId: "acc_new",
          profileId: "profile_other",
          platform: "linkedin",
          username: "acme-inc",
          displayName: "Acme Inc",
        },
      },
    });

    expect(result.accountId).not.toBeNull();
    const accounts = await t.query(api.lib.listAccounts, {
      zernioProfileId: "profile_other",
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      zernioAccountId: "acc_new",
      platform: "linkedin",
      displayName: "Acme Inc",
      isActive: true,
    });
    // The profile this component syncs is untouched.
    expect(
      await t.query(api.lib.listAccounts, { zernioProfileId: profileId }),
    ).toHaveLength(0);
  });
});
