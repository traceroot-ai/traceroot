import { describe, it, expect } from "vitest";
import { versionSnowflake, versionSnowflakeFromMs } from "./snowflake";

/**
 * The snowflake is now the STORED DatasetVersion primary key, generated at creation
 * and mirrored by the SQL backfill migration, so its exact layout is a contract:
 * `((createMs - 1704067200000) << 22) | versionNumber`, a decimal string.
 */
describe("versionSnowflakeFromMs", () => {
  it("packs the timestamp above the version number and returns a decimal string", () => {
    const EPOCH = 1704067200000;
    const createMs = EPOCH + 5; // 5ms past epoch
    const versionNumber = 3;
    const expected = ((BigInt(createMs) - BigInt(EPOCH)) << BigInt(22)) | BigInt(versionNumber);
    expect(versionSnowflakeFromMs(createMs, versionNumber)).toBe(expected.toString());
    expect(versionSnowflakeFromMs(createMs, versionNumber)).toMatch(/^\d+$/);
    // 5ms << 22 | 3 = 20971520 + 3
    expect(versionSnowflakeFromMs(createMs, versionNumber)).toBe("20971523");
  });

  it("sorts chronologically — a later ms yields a larger id", () => {
    const a = BigInt(versionSnowflakeFromMs(1704067200000 + 1000, 9));
    const b = BigInt(versionSnowflakeFromMs(1704067200000 + 2000, 1));
    expect(b > a).toBe(true);
  });

  it("is distinct per version number within the same millisecond", () => {
    const ms = 1704067200000 + 42;
    expect(versionSnowflakeFromMs(ms, 1)).not.toBe(versionSnowflakeFromMs(ms, 2));
  });

  it("versionSnowflake(iso) agrees with versionSnowflakeFromMs(parsedMs)", () => {
    const ms = 1704067200000 + 123456;
    const iso = new Date(ms).toISOString();
    expect(versionSnowflake(iso, 7)).toBe(versionSnowflakeFromMs(ms, 7));
  });
});
