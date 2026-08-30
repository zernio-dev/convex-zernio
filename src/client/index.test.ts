import { afterEach, describe, expect, test, vi } from "vitest";
import {
  actionGeneric,
  anyApi,
  mutationGeneric,
  queryGeneric,
  type ApiFromModules,
} from "convex/server";
import { v } from "convex/values";
import { isZernioApiError, Zernio, ZernioError } from "./index.js";
import { components, initConvexTest } from "./setup.test.js";

const baseUrl = "https://zernio.test/api";

const singleTenant = new Zernio(components.zernio, {
  apiKey: "zk_test",
  baseUrl,
  profileId: "profile_1",
});

const multiTenant = new Zernio(components.zernio, {
  apiKey: "zk_test",
  baseUrl,
  getUserInfo: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      throw new Error("Unauthorized");
    }
    return { userId: identity.subject, email: identity.email };
  },
});

// No apiKey and no profileId: both come from the environment, read per call.
const envTenant = new Zernio(components.zernio, { baseUrl });

export const sync = actionGeneric({
  args: {},
  handler: async (ctx) => await singleTenant.syncAccounts(ctx),
});

export const schedule = mutationGeneric({
  args: { content: v.string() },
  handler: async (ctx, args) =>
    await singleTenant.schedulePost(ctx, {
      accountIds: ["acc_x"],
      content: args.content,
    }),
});

export const postStatus = queryGeneric({
  args: { postId: v.string() },
  handler: async (ctx, args) => await singleTenant.status(ctx, args.postId),
});

export const usage = actionGeneric({
  args: {},
  handler: async (ctx) =>
    await singleTenant.request(ctx, { method: "GET", path: "/v1/usage" }),
});

export const syncExpectingError = actionGeneric({
  args: {},
  handler: async (ctx) => {
    try {
      await singleTenant.syncAccounts(ctx);
    } catch (error) {
      if (isZernioApiError(error)) {
        return { status: error.status, code: error.code ?? null };
      }
      throw error;
    }
    return null;
  },
});

export const envSync = actionGeneric({
  args: {},
  handler: async (ctx) => await envTenant.syncAccounts(ctx),
});

export const envUsage = actionGeneric({
  args: {},
  handler: async (ctx) =>
    await envTenant.request(ctx, {
      method: "POST",
      path: "/v1/posts/zpost_1/unpublish",
      query: { profileId: "profile_env" },
      body: { platform: "twitter" },
    }),
});

const tenantApi = multiTenant.api();
export const tenantSync = tenantApi.syncAccounts;
export const tenantSchedule = tenantApi.schedulePost;
export const tenantPosts = tenantApi.listPosts;
export const tenantGetPost = tenantApi.getPost;
export const tenantStatus = tenantApi.status;
export const tenantCancel = tenantApi.cancelPost;

const testApi = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      sync: typeof sync;
      schedule: typeof schedule;
      postStatus: typeof postStatus;
      usage: typeof usage;
      envSync: typeof envSync;
      envUsage: typeof envUsage;
      syncExpectingError: typeof syncExpectingError;
      tenantSync: typeof tenantSync;
      tenantSchedule: typeof tenantSchedule;
      tenantPosts: typeof tenantPosts;
      tenantGetPost: typeof tenantGetPost;
      tenantStatus: typeof tenantStatus;
      tenantCancel: typeof tenantCancel;
    };
  }>
)["index.test"];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const accountsPayload = {
  hasAnalyticsAccess: false,
  accounts: [
    {
      _id: "acc_x",
      platform: "twitter",
      username: "@acme",
      displayName: "Acme",
      profileId: "profile_1",
      isActive: true,
    },
  ],
};

function stubRoutes(routes: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    routes(url, init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Zernio client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("single-tenant sync, schedule and status", async () => {
    const t = initConvexTest();
    stubRoutes(() => jsonResponse(200, accountsPayload));

    const accounts = await t.action(testApi.sync, {});
    expect(accounts).toHaveLength(1);
    expect(accounts[0].zernioAccountId).toBe("acc_x");

    const scheduled = await t.mutation(testApi.schedule, { content: "hello" });
    expect(scheduled.status).toBe("pending");
    const summary = await t.query(testApi.postStatus, {
      postId: scheduled.postId,
    });
    // testMode defaults to true, so nothing can reach a real audience.
    expect(summary?.testMode).toBe(true);
  });

  test("request() returns the raw envelope", async () => {
    const t = initConvexTest();
    stubRoutes((url) => {
      expect(url).toBe(`${baseUrl}/v1/usage`);
      return jsonResponse(200, { posts: 3 });
    });

    const result = await t.action(testApi.usage, {});
    expect(result).toEqual({ status: 200, ok: true, data: { posts: 3 } });
  });

  test("a Zernio 4xx surfaces as a typed ZernioApiError", async () => {
    const t = initConvexTest();
    stubRoutes(() =>
      jsonResponse(403, {
        error: "No access to profile",
        code: "insufficient_permissions",
      }),
    );

    const result = await t.action(testApi.syncExpectingError, {});
    expect(result).toEqual({
      status: 403,
      code: "insufficient_permissions",
    });
  });

  test("multi-tenant creates the Zernio profile on first sync", async () => {
    const t = initConvexTest().withIdentity({
      subject: "user_1",
      email: "user@acme.test",
    });
    const fetchMock = stubRoutes((url) => {
      if (url.includes("/v1/profiles")) {
        return jsonResponse(201, {
          message: "created",
          profile: { _id: "profile_user_1", name: "user@acme.test" },
        });
      }
      return jsonResponse(200, {
        ...accountsPayload,
        accounts: [
          { ...accountsPayload.accounts[0], profileId: "profile_user_1" },
        ],
      });
    });

    const accounts = await t.action(testApi.tenantSync, {});
    expect(accounts).toHaveLength(1);
    const [profileUrl, profileInit] = fetchMock.mock.calls[0];
    expect(profileUrl).toBe(`${baseUrl}/v1/profiles`);
    expect(
      (profileInit?.headers as Record<string, string>)["Idempotency-Key"],
    ).toBe("zernio-convex-profile-user_1");

    const scheduled = await t.mutation(testApi.tenantSchedule, {
      accountIds: ["acc_x"],
      content: "hello from the tenant",
    });
    expect(scheduled.duplicate).toBe(false);
    const posts = await t.query(testApi.tenantPosts, {});
    expect(posts).toHaveLength(1);

    // A second sync reuses the mapping instead of creating another profile.
    await t.action(testApi.tenantSync, {});
    const profileCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/v1/profiles"),
    );
    expect(profileCalls).toHaveLength(1);
  });

  test("one tenant cannot read or cancel another tenant's post", async () => {
    const t = initConvexTest();
    const owner = t.withIdentity({ subject: "user_1" });
    const other = t.withIdentity({ subject: "user_2" });
    let created = 0;
    stubRoutes((url) => {
      if (url.includes("/v1/profiles")) {
        created += 1;
        return jsonResponse(201, {
          profile: { _id: `profile_${created}`, name: "tenant" },
        });
      }
      // Each tenant connects its own account, under its own Zernio profile.
      const profile =
        new URL(url).searchParams.get("profileId") ?? "profile_1";
      return jsonResponse(200, {
        hasAnalyticsAccess: false,
        accounts: [
          {
            _id: `acc_${profile}`,
            platform: "twitter",
            username: "@acme",
            profileId: profile,
            isActive: true,
          },
        ],
      });
    });
    await owner.action(testApi.tenantSync, {});
    await other.action(testApi.tenantSync, {});
    const { postId } = await owner.mutation(testApi.tenantSchedule, {
      accountIds: ["acc_profile_1"],
      content: "the owner's announcement",
    });

    expect(await other.query(testApi.tenantGetPost, { postId })).toBeNull();
    expect(await other.query(testApi.tenantStatus, { postId })).toBeNull();
    await expect(
      other.action(testApi.tenantCancel, { postId }),
    ).rejects.toThrow(/Unknown post/);

    const post = await owner.query(testApi.tenantGetPost, { postId });
    expect(post?.content).toBe("the owner's announcement");
    expect(post?.status).toBe("pending");
  });

  test("api() refuses to expose functions without getUserInfo", () => {
    expect(() => singleTenant.api()).toThrow(ZernioError);
  });
});

describe("environment fallbacks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ZERNIO_API_KEY;
    delete process.env.ZERNIO_PROFILE_ID;
  });

  test("single-tenant reads the key and profile from the environment", async () => {
    process.env.ZERNIO_API_KEY = "zk_env";
    process.env.ZERNIO_PROFILE_ID = "profile_env";
    const t = initConvexTest();
    const fetchMock = stubRoutes(() => jsonResponse(200, accountsPayload));

    await t.action(testApi.envSync, {});

    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url)).searchParams.get("profileId")).toBe(
      "profile_env",
    );
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer zk_env",
    );
  });

  test("refuses to run single-tenant with no profile configured", async () => {
    process.env.ZERNIO_API_KEY = "zk_env";
    const t = initConvexTest();
    stubRoutes(() => jsonResponse(200, accountsPayload));

    await expect(t.action(testApi.envSync, {})).rejects.toThrow(
      /Missing profileId/,
    );
  });

  test("request() carries the method, query, body and bearer key", async () => {
    process.env.ZERNIO_API_KEY = "zk_env";
    process.env.ZERNIO_PROFILE_ID = "profile_env";
    const t = initConvexTest();
    const fetchMock = stubRoutes(() => jsonResponse(200, { unpublished: 1 }));

    const result = await t.action(testApi.envUsage, {});

    expect(result).toEqual({ status: 200, ok: true, data: { unpublished: 1 } });
    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      `${baseUrl}/v1/posts/zpost_1/unpublish`,
    );
    expect(parsed.searchParams.get("profileId")).toBe("profile_env");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer zk_env",
    );
    expect(JSON.parse(String(init?.body))).toEqual({ platform: "twitter" });
  });
});
