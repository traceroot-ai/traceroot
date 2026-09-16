import { describe, expect, it } from "vitest";
import { parseQueryWindow } from "../query-window.js";

describe("parseQueryWindow", () => {
  it("rejects an impossible calendar date instead of letting Date.parse roll it forward", () => {
    // Date.parse turns Feb 30 into Mar 2; the route promised a 400 for malformed bounds.
    const out = parseQueryWindow({
      start_time: "2026-02-30T00:00:00Z",
      end_time: "2026-03-05T00:00:00Z",
    });
    expect(out).toBeInstanceOf(Error);
    expect(String((out as Error).message)).toMatch(/calendar|date/);
  });

  it("accepts a real leap day", () => {
    const out = parseQueryWindow({
      start_time: "2028-02-29T00:00:00Z",
      end_time: "2028-03-01T00:00:00Z",
    });
    expect(out).toEqual({ start_time: "2028-02-29T00:00:00Z", end_time: "2028-03-01T00:00:00Z" });
  });
});
