/**
 * The live SSE stream merges incoming spans into the trace-detail cache with an
 * exact-match setQueryData. If its key differs from the one the panel reads by even
 * one element, every span event becomes a silent no-op — and it stays silent, because
 * invalidateQueries matches by prefix, so the view still refreshes on trace_complete.
 *
 * These pin the shape both sides derive from, so a future key change has to break a
 * test rather than quietly stop live updates.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { traceQueryKey } from "../index";

const HOOKS_DIR = join(__dirname, "..");

describe("traceQueryKey", () => {
  it("includes source, so a self-trace and a customer trace cannot share a cache entry", () => {
    expect(traceQueryKey("p1", "t1", "detector")).not.toEqual(traceQueryKey("p1", "t1", "user"));
  });

  it("normalises an absent source, so the key length never varies", () => {
    expect(traceQueryKey("p1", "t1")).toEqual(["trace", "p1", "t1", null]);
    expect(traceQueryKey("p1", "t1")).toHaveLength(traceQueryKey("p1", "t1", "detector").length);
  });
});

describe("every trace-detail cache reader and writer uses the factory", () => {
  // Asserted over source text: the failure this guards is one call site drifting to a
  // hand-built array, which no runtime test of the factory itself would notice.
  const files = ["use-trace-stream.ts", "index.ts"];

  it.each(files)("%s builds no trace key by hand", (file) => {
    const src = readFileSync(join(HOOKS_DIR, file), "utf8");
    const handBuilt = src.match(/\[\s*"trace"\s*,/g) ?? [];
    // The sole permitted literal is inside traceQueryKey's own return.
    expect(handBuilt.length).toBeLessThanOrEqual(file === "index.ts" ? 1 : 0);
  });

  it("the stream writes and invalidates through the factory", () => {
    const src = readFileSync(join(HOOKS_DIR, "use-trace-stream.ts"), "utf8");
    expect(src).toContain("setQueryData<TraceDetail>(traceQueryKey(projectId, traceId, source)");
    expect(src).toContain(
      "invalidateQueries({ queryKey: traceQueryKey(projectId, traceId, source) })",
    );
  });
});
