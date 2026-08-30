import { describe, expect, test } from "vitest";
import { computeZernioSignature, verifyZernioSignature } from "./signature.js";

const secret = "whsec_test";
const rawBody = '{"id":"evt_1","event":"post.published"}';
// Reference value from Zernio's own signer:
// crypto.createHmac("sha256", secret).update(rawBody).digest("hex")
const expected =
  "1cb7307c2be29a44bd9a019db1f92b90a6f12f3e01696fb5f25a0b32b68062c8";

describe("verifyZernioSignature", () => {
  test("matches Node's crypto.createHmac output", async () => {
    expect(await computeZernioSignature({ rawBody, secret })).toBe(expected);
    expect(
      await verifyZernioSignature({ rawBody, signature: expected, secret }),
    ).toBe(true);
  });

  test("accepts an uppercase or padded header value", async () => {
    expect(
      await verifyZernioSignature({
        rawBody,
        signature: ` ${expected.toUpperCase()} `,
        secret,
      }),
    ).toBe(true);
  });

  test("rejects a tampered body, a wrong secret and a truncated signature", async () => {
    expect(
      await verifyZernioSignature({
        rawBody: `${rawBody} `,
        signature: expected,
        secret,
      }),
    ).toBe(false);
    expect(
      await verifyZernioSignature({
        rawBody,
        signature: expected,
        secret: "whsec_other",
      }),
    ).toBe(false);
    expect(
      await verifyZernioSignature({
        rawBody,
        signature: expected.slice(0, 32),
        secret,
      }),
    ).toBe(false);
  });
});
