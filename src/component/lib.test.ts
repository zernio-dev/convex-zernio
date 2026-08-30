/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
  stubRoutes,
} from "./setup.test.js";

describe("schedulePost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("creates a pending post with a resolved platform target", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId, status, duplicate } = await schedule(t);

    expect(status).toBe("pending");
    expect(duplicate).toBe(false);
    const post = await t.query(api.lib.getPost, { postId });
    expect(post?.platforms).toEqual([
      { platform: "twitter", accountId: "acc_x", status: "pending" },
    ]);
    expect(post?.testMode).toBe(true);
    expect(post?.workId).toBeDefined();
  });

  test("is idempotent on identical content", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const first = await schedule(t);
    const second = await schedule(t);

    expect(second.duplicate).toBe(true);
    expect(second.postId).toBe(first.postId);
    const posts = await t.query(api.lib.listPosts, {
      zernioProfileId: profileId,
    });
    expect(posts).toHaveLength(1);
  });

  test("rejects an account the component has never synced", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    await expect(schedule(t, { accountIds: ["acc_unknown"] })).rejects.toThrow(
      /Unknown Zernio account/,
    );
  });

  test("refuses an account that belongs to another profile", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    await t.mutation(internal.lib.upsertProfileMapping, {
      userId: "user_2",
      zernioProfileId: "profile_2",
    });

    // acc_x is profile_1's account, so profile_2 must not be able to post to it.
    await expect(schedule(t, { userId: "user_2" })).rejects.toThrow(
      /Unknown Zernio account acc_x/,
    );
    expect(
      await t.query(api.lib.listPosts, { zernioProfileId: "profile_2" }),
    ).toEqual([]);
  });

  test("keeps idempotency keys tenant-local", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    await t.mutation(internal.lib.upsertAccounts, {
      zernioProfileId: "profile_2",
      accounts: [
        {
          zernioAccountId: "acc_other",
          platform: "twitter",
          username: "@other",
          isActive: true,
        },
      ],
      deactivateMissing: false,
    });

    const theirs = await schedule(t, {
      idempotencyKey: "shared-key",
      content: "their content",
    });
    const mine = await t.mutation(api.lib.schedulePost, {
      options,
      apiKey,
      zernioProfileId: "profile_2",
      accountIds: ["acc_other"],
      content: "my content",
      idempotencyKey: "shared-key",
    });

    expect(mine.duplicate).toBe(false);
    expect(mine.postId).not.toBe(theirs.postId);
    const post = await t.query(api.lib.getPost, {
      postId: mine.postId,
      zernioProfileId: "profile_2",
    });
    expect(post?.content).toBe("my content");
  });

  test("refuses to schedule without a profile", async () => {
    const t = initConvexTest();
    await expect(
      t.mutation(api.lib.schedulePost, {
        options,
        apiKey,
        userId: "user_1",
        accountIds: [],
        content: "hi",
      }),
    ).rejects.toThrow(/No Zernio profile/);
  });
});

describe("submitPost", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("test mode creates a Zernio draft and finalizes locally", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);
    const fetchMock = stubFetch(
      jsonResponse(201, {
        post: {
          _id: "zpost_1",
          status: "draft",
          platforms: [
            { platform: "twitter", accountId: "acc_x", status: "pending" },
          ],
        },
      }),
    );

    const result = await t.action(internal.lib.submitPost, {
      postId,
      options,
      apiKey,
    });

    expect(result).toEqual({ zernioPostId: "zpost_1", status: "draft" });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init?.body));
    expect(body.isDraft).toBe(true);
    expect(body.publishNow).toBeUndefined();
    expect(body.scheduledFor).toBeUndefined();
    expect(body.platforms).toEqual([
      { platform: "twitter", accountId: "acc_x" },
    ]);
    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("draft");
    expect(summary?.finalizedAt).not.toBeNull();
  });

  test("live mode without a schedule publishes now", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false });
    const fetchMock = stubFetch(
      jsonResponse(201, {
        post: {
          _id: "zpost_2",
          status: "published",
          platforms: [
            {
              platform: "twitter",
              accountId: "acc_x",
              status: "published",
              platformPostUrl: "https://x.com/acme/1",
            },
          ],
        },
      }),
    );

    const result = await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });

    expect(result.status).toBe("published");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body)).publishNow).toBe(true);
    const post = await t.query(api.lib.getPost, { postId });
    expect(post?.platforms[0].publishedUrl).toBe("https://x.com/acme/1");
  });

  test("keeps a 202 in flight for the webhook to finalize", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false });
    stubFetch(jsonResponse(202, { postId: "zpost_202", status: "queued" }));

    const result = await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });

    expect(result).toEqual({ zernioPostId: "zpost_202", status: "submitting" });
    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("submitting");
    expect(summary?.finalizedAt).toBeNull();
  });

  test("adopts the existing post on a 409 content dedup", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);
    stubFetch(
      jsonResponse(409, {
        error: "Duplicate content",
        details: { existingPostId: "zpost_existing" },
      }),
    );

    const result = await t.action(internal.lib.submitPost, {
      postId,
      options,
      apiKey,
    });

    expect(result).toEqual({
      zernioPostId: "zpost_existing",
      status: "scheduled",
    });
  });

  test("a permanent 4xx fails the post and does not retry", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);
    stubFetch(jsonResponse(400, { error: "content is required" }));

    await expect(
      t.action(internal.lib.submitPost, { postId, options, apiKey }),
    ).rejects.toThrow(/content is required/);

    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("failed");
    expect(summary?.errorMessage).toBe("content is required");
  });

  test("a 429 leaves the post submitting so the workpool retries", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);
    stubFetch(jsonResponse(429, { error: "Too many requests" }));

    await expect(
      t.action(internal.lib.submitPost, { postId, options, apiKey }),
    ).rejects.toThrow(/Too many requests/);

    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("submitting");
  });

  test("the enqueued workpool job submits the post", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    stubFetch(
      jsonResponse(201, {
        post: {
          _id: "zpost_workpool",
          status: "draft",
          platforms: [
            { platform: "twitter", accountId: "acc_x", status: "pending" },
          ],
        },
      }),
    );
    const { postId } = await schedule(t);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("draft");
    expect(summary?.zernioPostId).toBe("zpost_workpool");
  });

  test("does not call Zernio for a post cancelled before submission", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);
    await t.mutation(internal.lib.markPostCancelled, { postId });
    const fetchMock = stubFetch(jsonResponse(201, {}));

    const result = await t.action(internal.lib.submitPost, {
      postId,
      options,
      apiKey,
    });

    expect(result.status).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("submit retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("a retry adopts the post the first attempt created instead of posting again", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false });
    const created = {
      _id: "zpost_recovered",
      content: "hello world",
      status: "scheduled",
      createdAt: new Date().toISOString(),
      platforms: [
        { platform: "twitter", accountId: "acc_x", status: "pending" },
      ],
    };
    // The post reached Zernio; the response, or the write after it, did not.
    const fetchMock = stubRoutes((url, init) =>
      init?.method === "POST"
        ? jsonResponse(500, { error: "gateway" })
        : jsonResponse(200, { posts: [created] }),
    );

    await expect(
      t.action(internal.lib.submitPost, {
        postId,
        options: liveOptions,
        apiKey,
      }),
    ).rejects.toThrow(/gateway/);
    const result = await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });

    expect(result).toEqual({
      zernioPostId: "zpost_recovered",
      status: "scheduled",
    });
    const posts = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
  });

  test("a retry still posts when Zernio holds nothing from the first attempt", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false });
    const fetchMock = stubRoutes((url, init) => {
      if (init?.method !== "POST") {
        return jsonResponse(200, { posts: [] });
      }
      return fetchMock.mock.calls.filter(([, i]) => i?.method === "POST")
        .length === 1
        ? jsonResponse(503, { error: "unavailable" })
        : jsonResponse(201, {
            post: {
              _id: "zpost_second_try",
              status: "scheduled",
              platforms: [
                { platform: "twitter", accountId: "acc_x", status: "pending" },
              ],
            },
          });
    });

    await expect(
      t.action(internal.lib.submitPost, {
        postId,
        options: liveOptions,
        apiKey,
      }),
    ).rejects.toThrow(/unavailable/);
    const result = await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });

    expect(result.zernioPostId).toBe("zpost_second_try");
  });

  test("a retry refuses to post again while the reconcile itself is failing", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false });
    const fetchMock = stubRoutes((url, init) =>
      init?.method === "POST"
        ? jsonResponse(500, { error: "gateway" })
        : jsonResponse(500, { error: "list unavailable" }),
    );

    await expect(
      t.action(internal.lib.submitPost, {
        postId,
        options: liveOptions,
        apiKey,
      }),
    ).rejects.toThrow(/gateway/);
    await expect(
      t.action(internal.lib.submitPost, {
        postId,
        options: liveOptions,
        apiKey,
      }),
    ).rejects.toThrow(/list unavailable/);

    const posts = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
  });

  test("a 409 naming another row's post fails instead of aliasing it", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const first = await schedule(t, { content: "same content" });
    stubFetch(
      jsonResponse(201, { post: { _id: "zpost_shared", status: "draft" } }),
    );
    await t.action(internal.lib.submitPost, {
      postId: first.postId,
      options,
      apiKey,
    });
    const second = await schedule(t, {
      content: "same content",
      idempotencyKey: "deliberately-different",
    });
    stubFetch(
      jsonResponse(409, {
        error: "Duplicate content",
        details: { existingPostId: "zpost_shared" },
      }),
    );

    await expect(
      t.action(internal.lib.submitPost, {
        postId: second.postId,
        options,
        apiKey,
      }),
    ).rejects.toThrow(/already owns/);

    const post = await t.query(api.lib.getPost, { postId: second.postId });
    expect(post?.status).toBe("failed");
    expect(post?.zernioPostId).toBeUndefined();
  });
});

describe("syncAccounts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("stores accounts and deactivates the ones that disappeared", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    stubFetch(
      jsonResponse(200, {
        hasAnalyticsAccess: false,
        accounts: [
          {
            _id: "acc_x",
            platform: "twitter",
            username: "@acme",
            displayName: "Acme",
            profilePicture: null,
            profileId: { _id: profileId, name: "Acme" },
            isActive: true,
          },
        ],
      }),
    );

    const accounts = await t.action(api.lib.syncAccounts, {
      options,
      apiKey,
      zernioProfileId: profileId,
    });

    const byId = new Map(accounts.map((a) => [a.zernioAccountId, a]));
    expect(byId.get("acc_x")?.displayName).toBe("Acme");
    expect(byId.get("acc_x")?.avatarUrl).toBeUndefined();
    expect(byId.get("acc_ig")?.isActive).toBe(false);
  });
});

describe("cancelPost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("cancels a queued post without calling Zernio", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);
    const fetchMock = stubFetch(jsonResponse(200, {}));

    const result = await t.action(api.lib.cancelPost, {
      options,
      apiKey,
      postId,
    });

    expect(result).toEqual({ postId, status: "cancelled", cancelled: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("undoes a create that raced the cancel", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false });
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        // The cancel lands while POST /v1/posts is still in flight.
        await t.mutation(internal.lib.markPostCancelled, { postId });
        return jsonResponse(201, {
          post: {
            _id: "zpost_race",
            status: "scheduled",
            platforms: [
              { platform: "twitter", accountId: "acc_x", status: "pending" },
            ],
          },
        });
      }
      return jsonResponse(200, { message: "deleted" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });

    const post = await t.query(api.lib.getPost, { postId });
    expect(post?.status).toBe("cancelled");
    // The id is recorded either way, so the app can still see what was created.
    expect(post?.zernioPostId).toBe("zpost_race");
    // Without this the cancelled post stays scheduled in Zernio and publishes.
    expect(fetchMock.mock.calls).toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://zernio.test/api/v1/posts/zpost_race");
    expect(init?.method).toBe("DELETE");

    // The row is already cancelled, so cancelling again stays a no-op.
    const again = await t.action(api.lib.cancelPost, {
      options: liveOptions,
      apiKey,
      postId,
    });
    expect(again).toEqual({ postId, status: "cancelled", cancelled: false });
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  test("deletes the Zernio post recorded by an idempotent 202 replay", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { testMode: false });
    stubFetch(jsonResponse(202, { postId: "zpost_202", status: "queued" }));
    await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });
    const fetchMock = stubFetch(jsonResponse(200, { message: "deleted" }));

    const result = await t.action(api.lib.cancelPost, {
      options: liveOptions,
      apiKey,
      postId,
    });

    expect(result.cancelled).toBe(true);
    // The row still said "submitting", but Zernio already held the post.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://zernio.test/api/v1/posts/zpost_202");
    expect(init?.method).toBe("DELETE");
  });

  test("deletes a draft in Zernio and is a no-op the second time", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);
    stubFetch(jsonResponse(201, { post: { _id: "zpost_1", status: "draft" } }));
    await t.action(internal.lib.submitPost, { postId, options, apiKey });
    const fetchMock = stubFetch(jsonResponse(200, { message: "deleted" }));

    const first = await t.action(api.lib.cancelPost, {
      options,
      apiKey,
      postId,
    });
    const second = await t.action(api.lib.cancelPost, {
      options,
      apiKey,
      postId,
    });

    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://zernio.test/api/v1/posts/zpost_1");
    expect(init?.method).toBe("DELETE");
  });
});

describe("request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("returns the raw envelope instead of throwing on a non-2xx", async () => {
    const t = initConvexTest();
    stubFetch(jsonResponse(404, { error: "Not found" }));

    const result = await t.action(api.lib.request, {
      options,
      apiKey,
      method: "GET",
      path: "/v1/posts/nope",
    });

    expect(result).toEqual({
      status: 404,
      ok: false,
      data: { error: "Not found" },
    });
  });

  test("builds the URL, method, query and bearer header", async () => {
    const t = initConvexTest();
    const fetchMock = stubFetch(jsonResponse(200, { ok: true }));

    await t.action(api.lib.request, {
      options,
      apiKey,
      method: "PATCH",
      path: "/v1/posts/zpost_1",
      query: { profileId, expand: "platforms" },
      body: { content: "edited" },
    });

    const [url, init] = fetchMock.mock.calls[0];
    // Convex sorts record keys, so compare the parsed query, not the string.
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://zernio.test/api/v1/posts/zpost_1",
    );
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      profileId,
      expand: "platforms",
    });
    expect(init?.method).toBe("PATCH");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${apiKey}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ content: "edited" });
  });

  test("refuses an absolute URL so the API key cannot leak", async () => {
    const t = initConvexTest();
    await expect(
      t.action(api.lib.request, {
        options,
        apiKey,
        method: "GET",
        path: "https://evil.test/v1/posts",
      }),
    ).rejects.toThrow(/must start with/);
  });
});

describe("profile resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("single-tenant takes the profile straight from the argument", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);

    const post = await t.query(api.lib.getPost, { postId });
    expect(post?.zernioProfileId).toBe(profileId);
    expect(
      await t.query(api.lib.listPosts, { zernioProfileId: profileId }),
    ).toHaveLength(1);
    // No mapping row exists, so a user-scoped read sees nothing.
    expect(await t.query(api.lib.listPosts, { userId: "user_1" })).toEqual([]);
  });

  test("multi-tenant resolves the profile through the mapping", async () => {
    const t = initConvexTest();
    await seedAccounts(t, "profile_user_1");
    await t.mutation(internal.lib.upsertProfileMapping, {
      userId: "user_1",
      zernioProfileId: "profile_user_1",
    });

    const { postId } = await schedule(t, { userId: "user_1" });

    const post = await t.query(api.lib.getPost, { postId });
    expect(post?.zernioProfileId).toBe("profile_user_1");
    expect(await t.query(api.lib.listPosts, { userId: "user_1" })).toHaveLength(
      1,
    );
    expect(
      await t.query(api.lib.listPosts, { zernioProfileId: profileId }),
    ).toEqual([]);
  });

  test("scopes reads and cancels to the caller's profile", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t);

    expect(
      await t.query(api.lib.getPost, { postId, zernioProfileId: "profile_2" }),
    ).toBeNull();
    expect(
      await t.query(api.lib.getPostStatus, {
        postId,
        zernioProfileId: "profile_2",
      }),
    ).toBeNull();
    await expect(
      t.action(api.lib.cancelPost, {
        options,
        apiKey,
        postId,
        zernioProfileId: "profile_2",
      }),
    ).rejects.toThrow(/Unknown post/);

    const post = await t.query(api.lib.getPost, { postId });
    expect(post?.status).toBe("pending");
  });

  test("returns null for a postId that is not an id at all", async () => {
    const t = initConvexTest();

    expect(
      await t.query(api.lib.getPost, {
        postId: "not-an-id",
        zernioProfileId: profileId,
      }),
    ).toBeNull();
    expect(
      await t.query(api.lib.getPostStatus, {
        postId: "not-an-id",
        zernioProfileId: profileId,
      }),
    ).toBeNull();
  });

  test("adopts the profile Zernio names in a 409 conflict", async () => {
    const t = initConvexTest();
    stubRoutes((_url, init) =>
      init?.method === "POST"
        ? jsonResponse(409, {
            error: "A profile with that name already exists",
            details: { existingProfileId: "profile_existing" },
          })
        : jsonResponse(200, { hasAnalyticsAccess: false, accounts: [] }),
    );

    await t.action(api.lib.syncAccounts, { options, apiKey, userId: "user_1" });

    expect(
      await t.query(internal.lib.getProfileIdForUser, { userId: "user_1" }),
    ).toBe("profile_existing");
  });

  test("falls back to a lookup by name when the conflict names no id", async () => {
    const t = initConvexTest();
    stubRoutes((url, init) => {
      if (init?.method === "POST") {
        return jsonResponse(409, { error: "already exists" });
      }
      return url.includes("/v1/profiles")
        ? jsonResponse(200, {
            profiles: [{ _id: "profile_by_name", name: "user:user_1" }],
          })
        : jsonResponse(200, { hasAnalyticsAccess: false, accounts: [] });
    });

    await t.action(api.lib.syncAccounts, { options, apiKey, userId: "user_1" });

    expect(
      await t.query(internal.lib.getProfileIdForUser, { userId: "user_1" }),
    ).toBe("profile_by_name");
  });

  test("a racing double-create keeps the first profile for the user", async () => {
    const t = initConvexTest();
    const first = await t.mutation(internal.lib.upsertProfileMapping, {
      userId: "user_1",
      zernioProfileId: "profile_a",
    });
    const second = await t.mutation(internal.lib.upsertProfileMapping, {
      userId: "user_1",
      zernioProfileId: "profile_b",
    });

    expect(first).toBe("profile_a");
    expect(second).toBe("profile_a");
    expect(
      await t.query(internal.lib.getProfileIdForUser, { userId: "user_1" }),
    ).toBe("profile_a");
  });
});

describe("idempotency", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("the same idempotencyKey never creates a second post or a second job", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const fetchMock = stubFetch(
      jsonResponse(201, {
        post: {
          _id: "zpost_1",
          status: "draft",
          platforms: [
            { platform: "twitter", accountId: "acc_x", status: "pending" },
          ],
        },
      }),
    );

    const first = await schedule(t, { idempotencyKey: "job-42" });
    // Different content, same key: the key is the contract, not the body.
    const second = await schedule(t, {
      idempotencyKey: "job-42",
      content: "a different draft",
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(second).toEqual({
      postId: first.postId,
      status: "pending",
      duplicate: true,
    });
    expect(
      await t.query(api.lib.listPosts, { zernioProfileId: profileId }),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const post = await t.query(api.lib.getPost, { postId: first.postId });
    expect(post?.content).toBe("hello world");
  });

  test("sends the key as x-request-id so a retry replays in Zernio", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const { postId } = await schedule(t, { idempotencyKey: "job-42" });
    const fetchMock = stubFetch(
      jsonResponse(201, { post: { _id: "zpost_1", status: "draft" } }),
    );

    await t.action(internal.lib.submitPost, { postId, options, apiKey });

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>)["x-request-id"]).toBe(
      "job-42",
    );
  });

  test("a derived key stops blocking once the post settled and the window closed", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const first = await schedule(t);
    await t.mutation(internal.lib.recordSubmission, {
      postId: first.postId,
      zernioPostId: "zpost_1",
      status: "published",
      platforms: [],
      finalized: true,
    });

    const retry = await schedule(t);
    vi.advanceTimersByTime(11 * 60 * 1000);
    const nextDay = await schedule(t);

    // Inside the window it is a retry of the same call.
    expect(retry).toMatchObject({ postId: first.postId, duplicate: true });
    // Past it, the same content is schedulable again instead of silently lost.
    expect(nextDay.duplicate).toBe(false);
    expect(nextDay.postId).not.toBe(first.postId);
  });

  test("a cancelled post never blocks rescheduling the same content", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const first = await schedule(t);
    await t.mutation(internal.lib.markPostCancelled, { postId: first.postId });

    const again = await schedule(t);

    expect(again.duplicate).toBe(false);
    expect(again.postId).not.toBe(first.postId);
  });

  test("an explicit key keeps deduping regardless of the window", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const first = await schedule(t, { idempotencyKey: "weekly-notes" });
    await t.mutation(internal.lib.recordSubmission, {
      postId: first.postId,
      zernioPostId: "zpost_1",
      status: "published",
      platforms: [],
      finalized: true,
    });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    const again = await schedule(t, { idempotencyKey: "weekly-notes" });

    expect(again).toMatchObject({ postId: first.postId, duplicate: true });
  });

  test("derives a key that separates test mode from a live post", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const draft = await schedule(t);
    const live = await schedule(t, { testMode: false });

    expect(live.duplicate).toBe(false);
    expect(live.postId).not.toBe(draft.postId);
  });
});

describe("listPosts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("returns the newest posts first across mixed statuses", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const first = await schedule(t, { content: "first" });
    const second = await schedule(t, { content: "second" });
    const third = await schedule(t, { content: "third" });
    await t.mutation(internal.lib.recordSubmission, {
      postId: first.postId,
      zernioPostId: "zpost_first",
      status: "published",
      platforms: [],
      finalized: true,
    });
    await t.mutation(internal.lib.markPostCancelled, { postId: second.postId });

    const posts = await t.query(api.lib.listPosts, {
      zernioProfileId: profileId,
    });
    const newest = await t.query(api.lib.listPosts, {
      zernioProfileId: profileId,
      limit: 1,
    });

    expect(posts.map((post) => post.content)).toEqual([
      "third",
      "second",
      "first",
    ]);
    expect(newest.map((post) => post._id)).toEqual([third.postId]);
    expect(
      await t.query(api.lib.listPosts, {
        zernioProfileId: profileId,
        status: "cancelled",
      }),
    ).toHaveLength(1);
  });
});

describe("test mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("keeps a requested schedule local and still sends a draft", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const scheduledFor = Date.parse("2026-09-01T12:00:00.000Z");
    const { postId } = await schedule(t, { scheduledFor });
    const fetchMock = stubFetch(
      jsonResponse(201, {
        post: {
          _id: "zpost_draft",
          status: "draft",
          platforms: [
            { platform: "twitter", accountId: "acc_x", status: "pending" },
          ],
        },
      }),
    );

    await t.action(internal.lib.submitPost, { postId, options, apiKey });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({ isDraft: true });
    expect(body.scheduledFor).toBeUndefined();
    expect(body.publishNow).toBeUndefined();
    const summary = await t.query(api.lib.getPostStatus, { postId });
    // The intent is still on the row so the app can show what would have run.
    expect(summary?.scheduledFor).toBe(scheduledFor);
    expect(summary?.status).toBe("draft");
    expect(summary?.testMode).toBe(true);
  });

  test("a live scheduled post sends the ISO instant, not a draft", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const scheduledFor = Date.parse("2026-09-01T12:00:00.000Z");
    const { postId } = await schedule(t, { testMode: false, scheduledFor });
    const fetchMock = stubFetch(
      jsonResponse(201, {
        post: {
          _id: "zpost_live",
          status: "scheduled",
          platforms: [
            { platform: "twitter", accountId: "acc_x", status: "pending" },
          ],
        },
      }),
    );

    await t.action(internal.lib.submitPost, {
      postId,
      options: liveOptions,
      apiKey,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.scheduledFor).toBe("2026-09-01T12:00:00.000Z");
    expect(body.isDraft).toBeUndefined();
    expect(body.publishNow).toBeUndefined();
    const summary = await t.query(api.lib.getPostStatus, { postId });
    expect(summary?.status).toBe("scheduled");
    expect(summary?.finalizedAt).toBeNull();
  });
});

describe("rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("bulk scheduling one post per day never trips the hourly limit", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    const day = 24 * 60 * 60 * 1000;

    for (let i = 0; i < 30; i++) {
      await expect(
        schedule(t, {
          testMode: false,
          content: `day ${i}`,
          scheduledFor: Date.now() + (i + 1) * day,
        }),
      ).resolves.toMatchObject({ duplicate: false });
    }
  });

  test("keeps one tenant's request() budget away from another's", async () => {
    const t = initConvexTest();
    stubFetch(jsonResponse(200, { ok: true }));

    for (let i = 0; i < 30; i++) {
      await t.action(api.lib.request, {
        options,
        apiKey,
        method: "GET",
        path: "/v1/usage-stats",
        zernioProfileId: profileId,
      });
    }

    await expect(
      t.action(api.lib.request, {
        options,
        apiKey,
        method: "GET",
        path: "/v1/usage-stats",
        zernioProfileId: profileId,
      }),
    ).rejects.toThrow(/rate limit/);
    await expect(
      t.action(api.lib.request, {
        options,
        apiKey,
        method: "GET",
        path: "/v1/usage-stats",
        zernioProfileId: "profile_2",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  test("stops a live account at Zernio's 25 posts per hour, drafts excepted", async () => {
    const t = initConvexTest();
    await seedAccounts(t);
    for (let i = 0; i < 25; i++) {
      await schedule(t, { testMode: false, content: `live post ${i}` });
    }

    await expect(
      schedule(t, { testMode: false, content: "live post 26" }),
    ).rejects.toThrow(/RateLimited/);
    // A draft skips Zernio's velocity checks, so it must not spend a token.
    await expect(
      schedule(t, { content: "draft after the limit" }),
    ).resolves.toMatchObject({ duplicate: false });
  });
});
