import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/errors";
import {
  classifyTraceLoadFailure,
  TRACE_INGEST_WINDOW_MS,
  TRACE_NOT_FOUND_MAX_LOADS,
} from "./trace-load-failure";

const RECORDED_AT = "2026-07-17T10:24:00Z";
const recorded = new Date(RECORDED_AT).getTime();

function classify(
  error: unknown,
  opts: { failedLoads?: number; at?: number; recordedAt?: string | null } = {},
) {
  return classifyTraceLoadFailure({
    error,
    failedLoads: opts.failedLoads ?? 1,
    recordedAt: opts.recordedAt === undefined ? RECORDED_AT : opts.recordedAt,
    now: opts.at ?? recorded + 10_000,
  });
}

describe("classifyTraceLoadFailure", () => {
  describe("not found (404)", () => {
    const notFound = new ApiError(404, "Trace not found");

    it("reads as still ingesting right after the result was recorded", () => {
      expect(classify(notFound)).toBe("ingesting");
    });

    it("stops promising ingestion once the window has passed", () => {
      expect(classify(notFound, { at: recorded + TRACE_INGEST_WINDOW_MS - 1 })).toBe("ingesting");
      expect(classify(notFound, { at: recorded + TRACE_INGEST_WINDOW_MS })).toBe("delayed");
    });

    it("stops promising ingestion after repeated misses, however recent", () => {
      expect(classify(notFound, { failedLoads: TRACE_NOT_FOUND_MAX_LOADS - 1 })).toBe("ingesting");
      expect(classify(notFound, { failedLoads: TRACE_NOT_FOUND_MAX_LOADS })).toBe("delayed");
    });

    it("treats an unknown or unparseable record time as recent", () => {
      expect(classify(notFound, { recordedAt: null })).toBe("ingesting");
      expect(classify(notFound, { recordedAt: "not a date" })).toBe("ingesting");
      // Repeated misses still settle it.
      expect(classify(notFound, { recordedAt: null, failedLoads: TRACE_NOT_FOUND_MAX_LOADS })).toBe(
        "delayed",
      );
    });
  });

  it("reads a 401 as signed out, never as ingesting", () => {
    expect(classify(new ApiError(401, "Browser session required"))).toBe("signed-out");
  });

  it("reads a plain 403 as no access", () => {
    expect(classify(new ApiError(403, "No access to this project"))).toBe("forbidden");
  });

  it("tells a retention refusal apart from a plain 403", () => {
    const retention = new ApiError(403, {
      message: "Data outside retention window",
      retention_days: 15,
      cutoff: "2026-06-29T00:00:00",
      plan: "free",
    });
    expect(classify(retention)).toBe("retention");
  });

  it.each([500, 502, 503, 429, 400])("reads HTTP %i as a failed load", (status) => {
    expect(classify(new ApiError(status, "boom"))).toBe("failed");
  });

  it("reads a network failure (no HTTP status) as a failed load", () => {
    expect(classify(new TypeError("Failed to fetch"))).toBe("failed");
    expect(classify(undefined)).toBe("failed");
  });

  it("reads a request that timed out as a failed load, never as ingesting", () => {
    expect(classify(new DOMException("The operation timed out.", "TimeoutError"))).toBe("failed");
  });
});
