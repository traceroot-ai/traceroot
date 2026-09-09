import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { isRetentionError, getRetentionDetail } from "./retention";

const retentionDetail = {
  message: "Data outside retention window",
  retention_days: 15,
  cutoff: "2026-06-29T00:00:00",
  plan: "free",
};

describe("isRetentionError", () => {
  it("returns true for a 403 ApiError with retention detail", () => {
    const err = new ApiError(403, retentionDetail);
    expect(isRetentionError(err)).toBe(true);
  });

  it("returns false for a non-403 ApiError", () => {
    const err = new ApiError(500, retentionDetail);
    expect(isRetentionError(err)).toBe(false);
  });

  it("returns false for a plain Error", () => {
    expect(isRetentionError(new Error("boom"))).toBe(false);
  });

  it("returns false for a 403 without retention fields", () => {
    const err = new ApiError(403, { message: "forbidden" });
    expect(isRetentionError(err)).toBe(false);
  });

  it("returns false for non-error values", () => {
    expect(isRetentionError(null)).toBe(false);
    expect(isRetentionError(undefined)).toBe(false);
    expect(isRetentionError("string")).toBe(false);
  });
});

describe("getRetentionDetail", () => {
  it("extracts the detail from a retention ApiError", () => {
    const err = new ApiError(403, retentionDetail);
    expect(getRetentionDetail(err)).toEqual(retentionDetail);
  });

  it("returns null for a non-retention error", () => {
    expect(getRetentionDetail(new Error("boom"))).toBeNull();
  });

  it("returns null for a 403 without retention fields", () => {
    const err = new ApiError(403, "forbidden");
    expect(getRetentionDetail(err)).toBeNull();
  });
});
