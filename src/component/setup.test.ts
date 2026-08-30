/// <reference types="vite/client" />
import { test, vi } from "vitest";
import { convexTest } from "convex-test";
import rateLimiter from "@convex-dev/rate-limiter/test";
import workpool from "@convex-dev/workpool/test";
import { api, internal } from "./_generated/api.js";
import schema from "./schema.js";
export const modules = import.meta.glob("./**/*.*s");

export function initConvexTest() {
  const t = convexTest(schema, modules);
  workpool.register(t, "postWorkpool");
  rateLimiter.register(t, "rateLimiter");
  return t;
}

export type TestConvexInstance = ReturnType<typeof initConvexTest>;

export const options = { baseUrl: "https://zernio.test/api", testMode: true };
export const liveOptions = { ...options, testMode: false };
export const apiKey = "zk_test";
export const profileId = "profile_1";

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function stubFetch(response: Response | (() => Response)) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    typeof response === "function" ? response() : response.clone(),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function stubRoutes(
  routes: (url: string, init?: RequestInit) => Response,
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
    routes(String(url), init),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export async function seedAccounts(
  t: TestConvexInstance,
  zernioProfileId: string = profileId,
) {
  await t.mutation(internal.lib.upsertAccounts, {
    zernioProfileId,
    accounts: [
      {
        zernioAccountId: "acc_x",
        platform: "twitter",
        username: "@acme",
        isActive: true,
      },
      {
        zernioAccountId: "acc_ig",
        platform: "instagram",
        username: "acme",
        isActive: true,
      },
    ],
    deactivateMissing: true,
  });
}

export async function schedule(
  t: TestConvexInstance,
  overrides: {
    content?: string;
    testMode?: boolean;
    accountIds?: string[];
    scheduledFor?: number;
    idempotencyKey?: string;
    userId?: string;
  } = {},
) {
  const { content, testMode, accountIds, ...rest } = overrides;
  return await t.mutation(api.lib.schedulePost, {
    options: testMode === false ? liveOptions : options,
    apiKey,
    ...(rest.userId === undefined ? { zernioProfileId: profileId } : {}),
    accountIds: accountIds ?? ["acc_x"],
    content: content ?? "hello world",
    ...rest,
  });
}

test("setup", () => {});
