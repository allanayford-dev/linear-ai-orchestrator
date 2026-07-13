import { createHmac, timingSafeEqual } from "node:crypto";

export function createLinearSignature(secret: string, rawBody: Buffer): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyLinearSignature(
  secret: string,
  rawBody: Buffer,
  headerSignature: string | undefined,
): boolean {
  if (!headerSignature || !/^[a-f\d]{64}$/i.test(headerSignature)) {
    return false;
  }

  const expected = Buffer.from(createLinearSignature(secret, rawBody), "hex");
  const actual = Buffer.from(headerSignature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isWebhookTimestampCurrent(
  timestamp: number,
  now: number,
  toleranceMs: number,
): boolean {
  return Math.abs(now - timestamp) <= toleranceMs;
}
