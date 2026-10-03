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

  it.each([
    {
      name: "keeps an orphan and its descendants when the parent is absent",
      spans: [
        { span_id: "child", parent_span_id: "missing", name: "service child" },
        { span_id: "leaf", parent_span_id: "child", name: "provider call" },
      ],
      tree: { child_service_child: { leaf_provider_call: {} } },
    },
    {
      name: "keeps rooted and orphan branches in source order",
      spans: [
        { span_id: "root", parent_span_id: null, name: "root" },
        { span_id: "nested", parent_span_id: "root", name: "nested" },
        { span_id: "orphan", parent_span_id: "missing", name: "orphan" },
        { span_id: "leaf", parent_span_id: "orphan", name: "leaf" },
      ],
      tree: { root_root: { nested_nested: {} }, orphan_orphan: { leaf_leaf: {} } },
    },
    {
      name: "keeps a child nested when its parent appears later in the response",
      spans: [
        { span_id: "child", parent_span_id: "root", name: "child" },
        { span_id: "root", parent_span_id: null, name: "root" },
        { span_id: "sibling", parent_span_id: "root", name: "sibling" },
      ],
      tree: { root_root: { child_child: {}, sibling_sibling: {} } },
    },
    {
      name: "keeps an empty trace empty",
      spans: [],
      tree: {},
    },
  ])("$name", async ({ spans, tree }) => {
    const trace = { name: "demo", spans };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => trace }));

    const result = await downloadOneTrace(
      "tid-1",
      "/workspace/traces",
      "proj-1",
      "user-1",
      executor,
    );

    expect(result).toEqual({
      dir: "/workspace/traces/tid-1_demo",
      spanCount: spans.length,
      traceName: "demo",
    });
    expect(executor.writeFile).toHaveBeenNthCalledWith(
      1,
      `${result.dir}/trace.jsonl`,
      JSON.stringify({ name: "demo" }) + "\n",
    );
    expect(executor.writeFile).toHaveBeenNthCalledWith(
      2,
      `${result.dir}/tree.json`,
      JSON.stringify(tree, null, 2),
    );
    expect(executor.writeFile).toHaveBeenNthCalledWith(
      3,
      `${result.dir}/spans.jsonl`,
      spans.map((span) => JSON.stringify(span)).join("\n") + "\n",
    );
    expect(executor.writeFile).toHaveBeenCalledTimes(3);
  });
});
