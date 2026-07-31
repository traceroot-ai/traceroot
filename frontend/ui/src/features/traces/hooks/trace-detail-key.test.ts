/**
 * The live SSE stream merges incoming spans into the trace-detail cache with an
 * exact-match setQueryData. If its key differs from the one the panel reads by even
 * one element, every span event becomes a silent no-op — and it stays silent, because
 * invalidateQueries matches by prefix, so the view still refreshes on trace_complete.
 *
 * These pin the shape both sides derive from, so a future key change has to break a
 * test rather than quietly stop live updates. Behaviour of the writer itself is covered
 * by use-trace-stream.test.tsx; this file only guards the shared shape.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { traceQueryKey } from "./index";

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
  //
  // The panel is listed because it is the half that actually drifted — the writer
  // (use-trace-stream) and the reader (TraceViewerPanel) fell out of step, so a guard
  // covering only the hooks directory would have watched the wrong pair.
  const files: Array<{ path: string; allowedLiterals: number }> = [
    { path: "use-trace-stream.ts", allowedLiterals: 0 },
    // The sole permitted literal is inside traceQueryKey's own return.
    { path: "index.ts", allowedLiterals: 1 },
    { path: "../components/TraceViewerPanel.tsx", allowedLiterals: 0 },
  ];

  it.each(files)("$path builds no trace key by hand", ({ path, allowedLiterals }) => {
    const src = readFileSync(join(__dirname, path), "utf8");
    const handBuilt = src.match(/\[\s*"trace"\s*,/g) ?? [];
    expect(handBuilt.length).toBeLessThanOrEqual(allowedLiterals);
  });
});
