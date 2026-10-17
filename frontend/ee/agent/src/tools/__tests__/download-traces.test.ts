import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createDownloadTracesTool, downloadOneTrace } from "../download-traces.js";
import type { Executor } from "../../executors/interface.js";

// Only writeFile and isReady are exercised here; stub the rest of Executor.
const executor = {
  writeFile: vi.fn().mockResolvedValue(undefined),
  isReady: vi.fn().mockReturnValue(true),
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

describe("createDownloadTracesTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("suggests a grep for LLM spans that matches the spans.jsonl it wrote", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          name: "demo",
          spans: [{ span_id: "s1", parent_span_id: null, name: "chat", span_kind: "LLM" }],
        }),
      }),
    );

    const tool = createDownloadTracesTool("proj-1", "user-1", executor);
    const result = await tool.execute("call-1", { traceIds: ["tid-1"] });
    const text = (result.content[0] as { text: string }).text;

    const pattern = text.match(/grep '([^']+)' \S+\/spans\.jsonl/)?.[1];
    expect(pattern).toBe('"span_kind":"LLM"');
    const spansWrite = vi
      .mocked(executor.writeFile)
      .mock.calls.find(([path]) => String(path).endsWith("/spans.jsonl"));
    expect(String(spansWrite?.[1])).toContain(pattern);
  });
});
