import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { downloadOneTrace } from "../download-traces.js";
import type { Executor } from "../../executors/interface.js";

// Only writeFile is exercised by downloadOneTrace; stub the rest of Executor.
const executor = {
  writeFile: vi.fn().mockResolvedValue(undefined),
} as unknown as Executor;

describe("downloadOneTrace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests the full projection (fields=full) on the internal trace read", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: "demo",
        spans: [{ span_id: "s1", parent_span_id: null, name: "root", input: "in" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await downloadOneTrace(
      "tid-1",
      "/workspace/traces",
      "proj-1",
      "user-1",
      executor,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    // The agent must opt into full fidelity so spans carry per-span I/O — the
    // internal read defaults to a lightweight skeleton otherwise (#1040).
    expect(url).toContain("/api/v1/projects/proj-1/traces/tid-1");
    expect(url).toContain("?fields=full");
    expect(result.spanCount).toBe(1);
  });
});
