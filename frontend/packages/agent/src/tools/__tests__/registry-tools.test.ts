import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Executor } from "../../executors/interface.js";
import {
  formatDetectorDetail,
  formatDetectorList,
  formatFindingDetail,
  formatFindingList,
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

  it("exposes exactly the eight internally-bound read tools", () => {
    const names = createRegistryReadTools("p1", "u1").map((t) => t.name);
    expect(names).toEqual([
      "list_traces",
      "list_sessions",
      "get_session",
      "list_detectors",
      "get_detector",
      "list_findings",
      "get_finding",
      "get_finding_by_trace",
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

  it("list_findings hits the internal detectors route with query filters", async () => {
    const impl = stubFetch({ data: [], meta: {} });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_findings")!;
    await tool.execute("id", { label: "x", detector: "error-rate", trace_id: "t1" });
    const [url, init] = impl.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://fastapi.test/api/v1/projects/p1/detectors/findings?detector=error-rate&trace_id=t1",
    );
    expect((init as RequestInit).headers).toMatchObject({
      "X-Internal-Secret": "s3cret",
      "x-user-id": "u1",
    });
  });

  it("get_finding_by_trace hits the internal trace-finding route", async () => {
    const impl = stubFetch({
      finding_id: "f1",
      trace_id: "t1",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: [],
      summary: "s",
      results: [],
      rca: null,
    });
    const tool = createRegistryReadTools("p1", "u1").find(
      (t) => t.name === "get_finding_by_trace",
    )!;
    await tool.execute("id", { label: "x", trace_id: "t1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors/traces/t1/finding");
  });

  it("get_finding hits the internal finding route and formats the detail with RCA", async () => {
    const impl = stubFetch({
      finding_id: "f1",
      trace_id: "t1",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: ["Error spike"],
      summary: "Elevated error rate",
      results: [],
      rca: { status: "completed", result: "Root cause: bad deploy" },
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_finding")!;
    const result = await tool.execute("id", { label: "x", finding_id: "f1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors/findings/f1");
    expect(result.content[0]!.text).toContain("Finding: f1");
    expect(result.content[0]!.text).toContain("RCA (completed):");
    expect(result.content[0]!.text).toContain("Root cause: bad deploy");
  });

  it("list_detectors hits the internal detectors route and runs the catalog formatter", async () => {
    const impl = stubFetch({
      data: [{ detector_id: "det-1", name: "Error spike", template: "error-rate", enabled: true }],
      meta: { total: 1 },
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "list_detectors")!;
    const result = await tool.execute("id", { label: "x" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors");
    // Exact rendering is owned by the formatter tests; this proves dispatch + formatter wiring.
    expect(result.content[0]!.text).toContain("Found 1 detectors");
    expect(result.content[0]!.text).toContain("det-1");
  });

  it("get_detector hits the internal detector route and renders the config", async () => {
    const impl = stubFetch({
      detector_id: "det-1",
      name: "Error spike",
      template: "failure",
      enabled: true,
      created_at: "2026-08-01T12:00:00Z",
      prompt: "Flag traces with elevated error rates",
      output_schema: { type: "object" },
      sample_rate: 25,
      enable_rca: true,
      detection_model: "claude-haiku-4-5",
      detection_source: "system",
      updated_at: "2026-08-02T09:00:00Z",
      trigger_conditions: [{ field: "root_span_finished", op: "=", value: true }],
    });
    const tool = createRegistryReadTools("p1", "u1").find((t) => t.name === "get_detector")!;
    const result = await tool.execute("id", { label: "x", detector_id: "det-1" });
    const [url] = impl.mock.calls[0]!;
    expect(String(url)).toBe("http://fastapi.test/api/v1/projects/p1/detectors/det-1");
    expect(result.content[0]!.text).toContain("Detector: det-1");
    expect(result.content[0]!.text).toContain("Flag traces with elevated error rates");
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
      "list_detectors",
      "get_detector",
      "list_findings",
      "get_finding",
      "get_finding_by_trace",
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

  it("formatDetectorList renders rows and reports the empty state", () => {
    expect(formatDetectorList({})).toBe("No detectors found.");
    expect(
      formatDetectorList({
        data: [
          {
            detector_id: "det-1",
            name: "Error spike",
            template: "error-rate",
            enabled: true,
            created_at: "2026-08-01T12:00:00Z",
          },
          { detector_id: "det-2", name: "Latency", template: "latency", enabled: false },
        ],
        meta: { total: 9 },
      }),
    ).toBe(
      "Found 2 detectors (9 total, showing 2):\n" +
        "- det-1 | Error spike | template: error-rate | enabled | created 2026-08-01T12:00:00Z\n" +
        "- det-2 | Latency | template: latency | disabled | created unknown",
    );
  });

  it("formatDetectorList appends the pagination hint only when next_cursor is set", () => {
    const row = {
      detector_id: "det-1",
      name: "Error spike",
      template: "error-rate",
      enabled: true,
      created_at: "2026-08-01T12:00:00Z",
    };
    expect(formatDetectorList({ data: [row], meta: { total: 9, next_cursor: "abc123" } })).toBe(
      "Found 1 detectors (9 total, showing 1):\n" +
        "- det-1 | Error spike | template: error-rate | enabled | created 2026-08-01T12:00:00Z\n" +
        'More results available — call again with cursor="abc123" to continue.',
    );
    expect(formatDetectorList({ data: [row], meta: { total: 9 } })).not.toContain(
      "More results available",
    );
  });

  it("formatDetectorDetail renders the full config", () => {
    expect(
      formatDetectorDetail({
        detector_id: "det-1",
        name: "Error spike",
        template: "failure",
        enabled: true,
        created_at: "2026-08-01T12:00:00Z",
        prompt: "Flag traces with elevated error rates",
        output_schema: { type: "object" },
        sample_rate: 25,
        enable_rca: true,
        detection_model: "claude-haiku-4-5",
        detection_provider: "anthropic",
        detection_source: "system",
        updated_at: "2026-08-02T09:00:00Z",
        trigger_conditions: [{ field: "root_span_finished", op: "=", value: true }],
      }),
    ).toBe(
      "Detector: det-1 | Error spike\n" +
        "Template: failure | enabled | sample rate: 25% | RCA: on\n" +
        "Detection: claude-haiku-4-5 via anthropic (system) | created 2026-08-01T12:00:00Z | updated 2026-08-02T09:00:00Z\n" +
        "\n" +
        "Prompt: Flag traces with elevated error rates\n" +
        'Output schema: {"type":"object"}\n' +
        'Trigger conditions: [{"field":"root_span_finished","op":"=","value":true}]',
    );
  });

  it("formatDetectorDetail states missing config pieces explicitly", () => {
    const text = formatDetectorDetail({
      detector_id: "det-2",
      name: "Latency",
      template: "blank",
      enabled: false,
      prompt: "",
      sample_rate: 100,
      enable_rca: false,
    });
    expect(text).toContain("disabled");
    expect(text).toContain("RCA: off");
    expect(text).toContain("Detection: default (unknown)");
    expect(text).toContain("Prompt: (none)");
    expect(text).toContain("Output schema: (none)");
    expect(text).toContain("Trigger conditions: (none — runs on every sampled trace)");
  });

  it("formatDetectorDetail truncates a long prompt to 1000 chars", () => {
    const text = formatDetectorDetail({
      detector_id: "det-3",
      name: "n",
      prompt: "p".repeat(1200),
      sample_rate: 50,
    });
    expect(text).toContain("p".repeat(1000));
    expect(text).not.toContain("p".repeat(1001));
  });

  it("formatFindingList renders rows with truncated summaries and the empty state", () => {
    expect(formatFindingList({})).toBe("No detector findings found matching the given filters.");
    const text = formatFindingList({
      data: [
        {
          finding_id: "f-1",
          trace_id: "t-1",
          timestamp: "2026-08-11T09:00:00Z",
          detectors: ["Error spike", "Latency"],
          summary: "y".repeat(250),
        },
      ],
      meta: { total: 3 },
    });
    expect(text).toContain("Found 1 findings (3 total, showing 1):");
    expect(text).toContain(
      "- f-1 | trace t-1 | 2026-08-11T09:00:00Z | detectors: Error spike, Latency",
    );
    expect(text).toContain("y".repeat(200));
    expect(text).not.toContain("y".repeat(201));
  });

  it("formatFindingList appends the pagination hint only when next_cursor is set", () => {
    const row = {
      finding_id: "f-1",
      trace_id: "t-1",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: ["Error spike"],
      summary: "Elevated error rate",
    };
    expect(formatFindingList({ data: [row], meta: { total: 9, next_cursor: "abc123" } })).toBe(
      "Found 1 findings (9 total, showing 1):\n" +
        "- f-1 | trace t-1 | 2026-08-11T09:00:00Z | detectors: Error spike\n" +
        "  Elevated error rate\n" +
        'More results available — call again with cursor="abc123" to continue.',
    );
    expect(formatFindingList({ data: [row], meta: { total: 9 } })).not.toContain(
      "More results available",
    );
  });

  it("formatFindingDetail renders header, per-detector results, and RCA text", () => {
    expect(
      formatFindingDetail({
        finding_id: "f-1",
        trace_id: "t-1",
        timestamp: "2026-08-11T09:00:00Z",
        detectors: ["Error spike"],
        summary: "Elevated error rate",
        results: [
          {
            detector_id: "det-1",
            detector_name: "Error spike",
            template: "error-rate",
            summary: "errors spiked",
            identified: true,
            data: { count: 3 },
          },
        ],
        rca: { status: "completed", result: "Root cause: bad deploy" },
      }),
    ).toBe(
      "Finding: f-1\n" +
        "Trace: t-1 | Time: 2026-08-11T09:00:00Z | Detectors: Error spike\n" +
        "Summary: Elevated error rate\n" +
        "\n" +
        "Per-detector results:\n" +
        "#1 Error spike (template: error-rate)\n" +
        "   errors spiked\n" +
        '   Data: {"count":3}\n' +
        "\n" +
        "RCA (completed):\n" +
        "Root cause: bad deploy",
    );
  });

  it("formatFindingDetail states missing results and RCA explicitly", () => {
    const text = formatFindingDetail({
      finding_id: "f-2",
      trace_id: "t-2",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: [],
      summary: "",
    });
    expect(text).toContain("Detectors: unknown");
    expect(text).toContain("Summary: (no summary)");
    expect(text).toContain("Per-detector results: (none)");
    expect(text).toContain("RCA: none recorded for this finding.");
  });

  it("formatFindingDetail marks a pending RCA with empty text", () => {
    const text = formatFindingDetail({
      finding_id: "f-3",
      trace_id: "t-3",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: ["Error spike"],
      summary: "s",
      results: [],
      rca: { status: "pending", result: null },
    });
    expect(text).toContain("RCA (pending):");
    expect(text).toContain("(no RCA text yet)");
  });

  it("formatFindingDetail does not say 'yet' for a failed RCA with empty text", () => {
    const text = formatFindingDetail({
      finding_id: "f-4",
      trace_id: "t-4",
      timestamp: "2026-08-11T09:00:00Z",
      detectors: ["Error spike"],
      summary: "s",
      results: [],
      rca: { status: "failed", result: null },
    });
    expect(text).toContain("RCA (failed):");
    expect(text).toContain("(no RCA text)");
    expect(text).not.toContain("(no RCA text yet)");
  });
});
