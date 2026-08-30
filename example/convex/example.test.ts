import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { computeZernioSignature } from "@zernio/convex";
import { api } from "./_generated/api";
import { initConvexTest } from "./setup.test";

const secret = "whsec_example";

const payload = {
  id: "evt_1",
  event: "post.published",
  timestamp: "2026-08-30T10:00:00.000Z",
  post: {
    id: "zpost_1",
    content: "hello",
    status: "published",
    scheduledFor: "2026-08-30T09:00:00.000Z",
    platforms: [
      {
        platform: "twitter",
        accountId: "acc_x",
        status: "published",
        publishedUrl: "https://x.com/acme/1",
      },
    ],
  },
};

async function deliver(
  t: ReturnType<typeof initConvexTest>,
  overrides: { body?: string; signature?: string | null } = {},
) {
  const body = overrides.body ?? JSON.stringify(payload);
  const signature =
    overrides.signature === undefined
      ? await computeZernioSignature({ rawBody: body, secret })
      : overrides.signature;
  return await t.fetch("/zernio/webhook", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Zernio-Event": "post.published",
      "X-Zernio-Event-Id": "evt_1",
      ...(signature === null ? {} : { "X-Zernio-Signature": signature }),
    },
  });
}

describe("zernio webhook route", () => {
  beforeEach(() => {
    process.env.ZERNIO_WEBHOOK_SECRET = secret;
  });
  afterEach(() => {
    delete process.env.ZERNIO_WEBHOOK_SECRET;
  });

  test("accepts a signed delivery and calls back into the app", async () => {
    const t = initConvexTest();

    const response = await deliver(t);

    expect(response.status).toBe(200);
    const events = await t.query(api.example.postEvents, {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: "evt_1",
      event: "post.published",
      zernioPostId: "zpost_1",
      status: "published",
    });
  });

  test("a replay is acknowledged but applied only once", async () => {
    const t = initConvexTest();

    await deliver(t);
    const replay = await deliver(t);

    expect(replay.status).toBe(200);
    expect(await t.query(api.example.postEvents, {})).toHaveLength(1);
  });

  test("rejects headers that contradict the signed body", async () => {
    const t = initConvexTest();
    const body = JSON.stringify(payload);
    const signature = await computeZernioSignature({ rawBody: body, secret });

    // The signature covers the body only, so a captured delivery must not be
    // replayable under a fresh event id, nor relabelled as another event.
    const relabelled = await t.fetch("/zernio/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Zernio-Event": "post.failed",
        "X-Zernio-Event-Id": "evt_1",
        "X-Zernio-Signature": signature,
      },
    });
    const reidentified = await t.fetch("/zernio/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Zernio-Event": "post.published",
        "X-Zernio-Event-Id": "evt_attacker_chosen",
        "X-Zernio-Signature": signature,
      },
    });

    expect(relabelled.status).toBe(400);
    expect(reidentified.status).toBe(400);
    expect(await t.query(api.example.postEvents, {})).toHaveLength(0);
  });

  test("takes the event name and id from the signed body", async () => {
    const t = initConvexTest();
    const body = JSON.stringify(payload);

    const response = await t.fetch("/zernio/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Zernio-Signature": await computeZernioSignature({
          rawBody: body,
          secret,
        }),
      },
    });

    expect(response.status).toBe(200);
    expect(await t.query(api.example.postEvents, {})).toMatchObject([
      { eventId: "evt_1", event: "post.published" },
    ]);
  });

  test("rejects a bad signature and a missing one", async () => {
    const t = initConvexTest();

    const tampered = await deliver(t, { signature: "0".repeat(64) });
    const unsigned = await deliver(t, { signature: null });

    expect(tampered.status).toBe(401);
    expect(unsigned.status).toBe(401);
    expect(await t.query(api.example.postEvents, {})).toHaveLength(0);
  });

  test("refuses to process anything when no secret is configured", async () => {
    delete process.env.ZERNIO_WEBHOOK_SECRET;
    const t = initConvexTest();

    const response = await deliver(t);

    expect(response.status).toBe(500);
    expect(await t.query(api.example.postEvents, {})).toHaveLength(0);
  });

  test("account events reach the app's account callback", async () => {
    const t = initConvexTest();
    const body = JSON.stringify({
      id: "evt_account",
      event: "account.disconnected",
      timestamp: "2026-08-30T10:00:00.000Z",
      account: {
        accountId: "acc_x",
        profileId: "profile_1",
        platform: "twitter",
        username: "@acme",
        disconnectionType: "unintentional",
        reason: "Token expired or revoked",
      },
    });

    const response = await t.fetch("/zernio/webhook", {
      method: "POST",
      body,
      headers: {
        "X-Late-Event": "account.disconnected",
        "X-Late-Event-Id": "evt_account",
        "X-Late-Signature": await computeZernioSignature({
          rawBody: body,
          secret,
        }),
      },
    });

    expect(response.status).toBe(200);
    const events = await t.query(api.example.accountEvents, {});
    expect(events).toEqual([
      expect.objectContaining({
        eventId: "evt_account",
        zernioAccountId: "acc_x",
        isActive: false,
      }),
    ]);
  });
});
