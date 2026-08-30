/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { computeZernioSignature } from "@zernio/convex";
import { api, components } from "./_generated/api";
import { initConvexTest } from "./setup.test";

const secret = "whsec_lifecycle";
const baseUrl = "https://zernio.test/api";
const apiKey = "zk_test";
const profileId = "profile_1";
const liveOptions = { baseUrl, testMode: false };
const zernioPostId = "zpost_live";

type TestConvexInstance = ReturnType<typeof initConvexTest>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubZernio() {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/v1/accounts")) {
      return jsonResponse(200, {
        hasAnalyticsAccess: false,
        accounts: [
          {
            _id: "acc_x",
            platform: "twitter",
            username: "@acme",
            displayName: "Acme",
            profileId,
            isActive: true,
          },
        ],
      });
    }
    return jsonResponse(201, {
      post: {
        _id: zernioPostId,
        status: "scheduled",
        platforms: [
          { platform: "twitter", accountId: "acc_x", status: "pending" },
        ],
      },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * A post the component has handed to Zernio and that only a webhook can
 * finalize, which is the state the delivery path actually has to handle. The
 * example app itself runs in test mode, so the live options are passed to the
 * component directly.
 */
async function liveScheduledPost(t: TestConvexInstance): Promise<string> {
  stubZernio();
  await t.action(components.zernio.lib.syncAccounts, {
    options: liveOptions,
    apiKey,
    zernioProfileId: profileId,
  });
  const { postId } = await t.mutation(components.zernio.lib.schedulePost, {
    options: liveOptions,
    apiKey,
    zernioProfileId: profileId,
    accountIds: ["acc_x"],
    content: "hello from the queue",
    scheduledFor: Date.parse("2026-08-30T12:00:00.000Z"),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return postId;
}

function publishedPayload(): Record<string, unknown> {
  return {
    id: "evt_published",
    event: "post.published",
    timestamp: "2026-08-30T12:00:05.000Z",
    post: {
      id: zernioPostId,
      content: "hello from the queue",
      status: "published",
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
}

async function deliver(
  t: TestConvexInstance,
  overrides: { signature?: string } = {},
): Promise<Response> {
  const body = JSON.stringify(publishedPayload());
  return await t.fetch("/zernio/webhook", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Zernio-Event": "post.published",
      "X-Zernio-Event-Id": "evt_published",
      "X-Zernio-Signature":
        overrides.signature ??
        (await computeZernioSignature({ rawBody: body, secret })),
    },
  });
}

describe("schedule to webhook, end to end", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ZERNIO_WEBHOOK_SECRET = secret;
    // Single-tenant reads are scoped to the configured profile, like every
    // other call, so a post belonging to another profile reads as unknown.
    process.env.ZERNIO_PROFILE_ID = profileId;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    delete process.env.ZERNIO_PROFILE_ID;
  });

  test("a signed post.published finalizes the post and calls the app back", async () => {
    const t = initConvexTest();
    const postId = await liveScheduledPost(t);
    expect(await t.query(api.example.status, { postId })).toMatchObject({
      status: "scheduled",
      zernioPostId,
    });

    const response = await deliver(t);

    expect(response.status).toBe(200);
    const summary = await t.query(api.example.status, { postId });
    expect(summary?.status).toBe("published");
    expect(summary?.platforms[0]).toMatchObject({
      status: "published",
      publishedUrl: "https://x.com/acme/1",
    });
    // Written inside the component's transaction, carrying the local post id.
    expect(await t.query(api.example.postEvents, {})).toEqual([
      expect.objectContaining({
        eventId: "evt_published",
        event: "post.published",
        postId,
        zernioPostId,
        status: "published",
      }),
    ]);
  });

  test("a replay of the same event id changes nothing the second time", async () => {
    const t = initConvexTest();
    const postId = await liveScheduledPost(t);

    const first = await deliver(t);
    const replay = await deliver(t);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(await t.query(api.example.postEvents, {})).toHaveLength(1);
    const post = await t.query(api.example.getPost, { postId });
    expect(post?.status).toBe("published");
    expect(post?.lastEventAt).toBe(Date.parse("2026-08-30T12:00:05.000Z"));
  });

  test("a forged signature is rejected and leaves the post alone", async () => {
    const t = initConvexTest();
    const postId = await liveScheduledPost(t);

    const response = await deliver(t, { signature: "f".repeat(64) });

    expect(response.status).toBe(401);
    expect(await t.query(api.example.status, { postId })).toMatchObject({
      status: "scheduled",
    });
    expect(await t.query(api.example.postEvents, {})).toEqual([]);
  });
});
