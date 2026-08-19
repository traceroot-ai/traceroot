import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../../executors/interface.js";
import {
  formatMetadataKeys,
  formatSessionDetail,
  formatSessionList,
  formatTraceList,
} from "../formatters.js";
import { createTools } from "../index.js";
import { createRegistryReadTools } from "../registry-tools.js";

describe("createRegistryReadTools", () => {
  beforeEach(() => {
    process.env.BACKEND_INTERNAL_URL = "http://fastapi.test";
    process.env.INTERNAL_API_SECRET = "s3cret";
  });
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(body: unknown) {
    const impl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", impl);
    return impl;
  }

  it("exposes exactly the internally-bound read tools", () => {
    const names = createRegistryReadTools("p1", "u1").map((t) => t.name);
    expect(names).toEqual([
      "list_traces",
      "list_sessions",
      "get_session",
      "list_trace_metadata_keys",
    ]);
  });

  it("hides the fixed project_id from every tool's model-facing schema", () => {
    for (const tool of createRegistryReadTools("p1", "u1")) {
      expect(tool.parameters.properties).not.toHaveProperty("project_id");
      expect(tool.parameters.properties).toHaveProperty("label");
    }
  });

  it("list_traces hits the internal project route with internal auth headers", async () => {
    const impl = stubFetch({ data: [], meta: {} });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_traces")!;
    await tool.execute("id", { label: "x", search_query: "checkout" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/traces?search_query=checkout");
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
  });

  it("get_session hits the internal session route with the model-supplied id", async () => {
    const impl = stubFetch({ session_id: "s1", trace_count: 0, traces: [] });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_session")!;
    await tool.execute("id", { label: "x", session_id: "s1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/sessions/s1");
  });

  it("formats trace lists as the summary table text", async () => {
    stubFetch({
      data: [
        {
          trace_id: "t1",
          name: "checkout",
          trace_start_time: "2026-07-01T00:00:00Z",
          error_count: 2,
          span_count: 7,
          duration_ms: 123.4,
        },
      ],
      meta: { total: 41 },
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_traces")!;
    const result = await tool.execute("id", { label: "x" });
    expect(result.content[0]!.text).toBe(
      "Found 1 traces (41 total, showing 1):\n" +
        "- t1 | checkout | 2026-07-01T00:00:00Z | 2 errors | 7 spans | 123ms",
    );
  });

  it("formats session lists as the per-session summary lines", async () => {
    stubFetch({
      data: [{ session_id: "s1", trace_count: 3, duration_ms: 4500.6, user_ids: ["u1", "u2"] }],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_sessions")!;
    const result = await tool.execute("id", { label: "x" });
    expect(result.content[0]!.text).toBe(
      "Found 1 sessions:\n- s1 | 3 traces | 4501ms | users: u1, u2",
    );
  });

  it("get_session formats the session detail with per-trace I/O", async () => {
    stubFetch({
      session_id: "s1",
      trace_count: 1,
      duration_ms: 5000,
      user_ids: ["u1"],
      traces: [
        {
          trace_id: "t1",
          name: "turn",
          status: "ok",
          duration_ms: 100,
          input: "hi",
          output: "yo",
        },
      ],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_session")!;
    const result = await tool.execute("id", { label: "x", session_id: "s1" });
    expect(result.content[0]!.text).toBe(
      "Session: s1\n" +
        "Traces: 1 | Duration: 5000ms | Users: u1\n" +
        "\n" +
        "#1 t1 — turn | ok | 100ms\n" +
        "   Input:  hi\n" +
        "   Output: yo",
    );
  });

  it("returns HTTP failures as tool text instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ detail: "Forbidden" }), { status: 403 })),
    );
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_traces")!;
    const result = await tool.execute("id", { label: "x" });
    expect(result.content[0]!.text).toContain("Error calling list_traces");
    expect(result.content[0]!.text).toContain("Forbidden");
  });
});

describe("createTools", () => {
  it("wires the registry read tools alongside the download, github, and sandbox tools", () => {
    const tools = createTools({
      projectId: "p1",
      userId: "u1",
      workspaceId: "w1",
      executor: {} as Executor,
    });
    expect(tools.map((t) => t.name)).toEqual([
      "list_traces",
      "list_sessions",
      "get_session",
      "list_trace_metadata_keys",
      "download_traces",
      "download_session",
      "check_github_access",
      "git_clone",
      "bash",
      "read",
      "write",
    ]);
  });
});

describe("formatters", () => {
  it("formatMetadataKeys reports the empty state and lists keys by frequency", () => {
    expect(formatMetadataKeys({})).toBe(
      "No metadata keys found on this project's traces or spans.",
    );
    const text = formatMetadataKeys({
      keys: [
        { value: "customer_tier", count: 15 },
        { value: "pipeline_stage", count: 30 },
      ],
    });
    expect(text).toContain("- customer_tier (15 occurrences)");
    expect(text).toContain("- pipeline_stage (30 occurrences)");
    expect(text).toContain('as the "key" of a metadata filter');
  });

  it("formatTraceList reports the empty state and tolerates missing fields", () => {
    expect(formatTraceList({})).toBe("No traces found matching the given filters.");
    expect(formatTraceList({ data: [], meta: {} })).toBe(
      "No traces found matching the given filters.",
    );
    expect(formatTraceList({ data: [{ trace_id: "t1", span_count: 1 }], meta: {} })).toBe(
      "Found 1 traces:\n- t1 | (unnamed) | undefined | 0 errors | 1 spans | ?",
    );
  });

  it("formatSessionList reports the empty state and missing-field fallbacks", () => {
    expect(formatSessionList({})).toBe("No sessions found.");
    expect(formatSessionList({ data: [{ session_id: "s1", trace_count: 0 }] })).toBe(
      "Found 1 sessions:\n- s1 | 0 traces | ? | users: none",
    );
  });

  it("formatSessionDetail reports the traceless state and missing-field fallbacks", () => {
    expect(formatSessionDetail({ session_id: "s9", traces: [] })).toBe("Session s9 has no traces.");
    expect(
      formatSessionDetail({
        session_id: "s9",
        trace_count: 1,
        traces: [{ trace_id: "t1", status: "error" }],
      }),
    ).toBe(
      "Session: s9\n" +
        "Traces: 1 | Duration: unknown | Users: none\n" +
        "\n" +
        "#1 t1 — (unnamed) | error | ?\n" +
        "   Input:  (none)\n" +
        "   Output: (none)",
    );
  });

  it("formatSessionDetail truncates long trace input and output to 200 chars", () => {
    const long = "x".repeat(250);
    const text = formatSessionDetail({
      session_id: "s1",
      trace_count: 1,
      traces: [{ trace_id: "t1", status: "ok", input: long, output: long }],
    });
    expect(text).toContain(`Input:  ${"x".repeat(200)}\n`);
    expect(text).not.toContain("x".repeat(201));
  });

  it("formatSessionDetail does not split a surrogate pair at the truncation boundary", () => {
    // "😀" is one code point but two UTF-16 units; placing it across the
    // 200-unit boundary would leave a lone high surrogate under plain slice.
    const input = "x".repeat(199) + "😀" + "tail";
    const text = formatSessionDetail({
      session_id: "s1",
      trace_count: 1,
      traces: [{ trace_id: "t1", status: "ok", input, output: "y" }],
    });
    const line = text.split("\n").find((l) => l.startsWith("   Input:"))!;
    expect(line).toBe(`   Input:  ${"x".repeat(199)}`);
    expect(text).not.toContain("\ud83d");
  });
});
