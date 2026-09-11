import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { stableDatasetId } from "./dataset-id";

/**
 * The formula is a cross-repo contract: the SDKs derive the same `ds_…` from the
 * same key, so a UI-authored and an SDK-authored dataset with the same key are one
 * dataset. These assertions pin the exact shape the SDK relies on.
 */
describe("stableDatasetId", () => {
  it("is 'ds_' + the first 26 hex chars of sha256(key)", () => {
    const key = "billing";
    const expected = "ds_" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 26);
    expect(stableDatasetId(key)).toBe(expected);
    // Shape: prefix + 26 lowercase hex chars.
    expect(stableDatasetId(key)).toMatch(/^ds_[0-9a-f]{26}$/);
  });

  it("hashes the key verbatim — case-sensitive, no trimming", () => {
    expect(stableDatasetId("Billing")).not.toBe(stableDatasetId("billing"));
    expect(stableDatasetId(" billing ")).not.toBe(stableDatasetId("billing"));
  });

  it("is deterministic for the same key", () => {
    expect(stableDatasetId("regression-set")).toBe(stableDatasetId("regression-set"));
  });
});
