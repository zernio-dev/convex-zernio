const encoder = new TextEncoder();

/**
 * Lowercase hex HMAC-SHA256, with no prefix and no version tag: exactly what
 * Zernio puts in `X-Zernio-Signature`.
 */
export async function computeZernioSignature(args: {
  rawBody: string;
  secret: string;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(args.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(args.rawBody),
  );
  return [...new Uint8Array(signed)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Verifies a Zernio webhook delivery. `rawBody` MUST be the raw request text:
 * re-serializing the parsed JSON would have to reproduce key order and number
 * formatting byte for byte, which is not guaranteed.
 */
export async function verifyZernioSignature(args: {
  rawBody: string;
  signature: string;
  secret: string;
}): Promise<boolean> {
  const expected = await computeZernioSignature({
    rawBody: args.rawBody,
    secret: args.secret,
  });
  return timingSafeEqual(expected, args.signature.trim().toLowerCase());
}
