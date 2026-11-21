import { createHash } from "crypto";

/** Hash a string to 32 lowercase hex chars (first 128 bits of sha256). */
export function hash32(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/** Hash a string to a uuid-shaped id (first 128 bits of sha256, 8-4-4-4-12). */
export function hashToUuid(input: string): string {
  return hash32(input).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
}
