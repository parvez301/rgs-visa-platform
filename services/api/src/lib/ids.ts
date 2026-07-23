import { randomBytes } from "node:crypto";

const ENCODING_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Time-sortable identifier: millisecond timestamp base32 + 16 random chars.
 * Sorts lexicographically by creation time, which the SK/GSI schemes rely on.
 */
export function newId(prefix: string, nowMs: number = Date.now()): string {
  let timePart = "";
  let remaining = nowMs;
  for (let digitIndex = 0; digitIndex < 10; digitIndex += 1) {
    timePart = ENCODING_ALPHABET[remaining % 32] + timePart;
    remaining = Math.floor(remaining / 32);
  }
  const randomPart = Array.from(randomBytes(16))
    .map((randomByte) => ENCODING_ALPHABET[randomByte % 32])
    .join("");
  return `${prefix}_${timePart}${randomPart}`;
}
