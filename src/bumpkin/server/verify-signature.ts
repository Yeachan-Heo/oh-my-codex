import { createHmac, timingSafeEqual } from 'node:crypto';

export function computeSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifySignature(
  secret: string,
  body: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = computeSignature(secret, body);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
