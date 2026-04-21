import { describe, it, expect } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Span } from "@/types/api";
import { enrichSpansWithPending } from "./index";

// Minimal span factory — only fields relevant to enrichSpansWithPending.
function makeSpan(overrides: Partial<Span> & { span_id: string }): Span {
  return {
    trace_id: "trace-1",
    parent_span_id: null,
    name: overrides.span_id,
    span_kind: SpanKind.SPAN,
    span_start_time: "2024-01-01T00:00:00.000Z",
    span_end_time: "2024-01-01T00:00:01.000Z",
    status: SpanStatus.OK,
    status_message: null,
    model_name: null,
    cost: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    input: null,
    output: null,
    metadata: null,
    git_source_file: null,
    git_source_line: null,
    git_source_function: null,
    ...overrides,
  };
}

function metadataWith(idsPath: string[], namePath: string[]): string {
  return JSON.stringify({
    "traceroot.span.ids_path": idsPath,
    "traceroot.span.path": namePath,
  });
}

describe("enrichSpansWithPending", () => {
  it("returns empty array unchanged", () => {
    expect(enrichSpansWithPending([])).toEqual([]);
  });

  it("returns root-only trace unchanged (no metadata, no parent)", () => {
    const root = makeSpan({ span_id: "root" });
    const result = enrichSpansWithPending([root]);
    expect(result).toHaveLength(1);
    expect(result[0].pending).toBeFalsy();
  });

  it("creates a placeholder for a missing direct parent", () => {
    // child knows its parent is 'parent-id' but parent hasn't arrived yet
    const child = makeSpan({
      span_id: "child",
      parent_span_id: "parent-id",
      metadata: metadataWith(["parent-id"], ["parent-name", "child"]),
    });

    const result = enrichSpansWithPending([child]);
    const placeholder = result.find((s) => s.span_id === "parent-id");

    expect(placeholder).toBeDefined();
    expect(placeholder!.pending).toBe(true);
    expect(placeholder!.name).toBe("parent-name");
    expect(placeholder!.parent_span_id).toBeNull();
  });

  it("creates placeholders for all missing ancestors (regression: demo_session + agent_turn gap)", () => {
    // Simulates the exact race condition: first SSE batch arrives with a deeply
    // nested span but root (demo_session) and intermediate (agent_turn) are missing.
    const rootId = "demo-session-id";
    const midId = "agent-turn-id";
    const child = makeSpan({
      span_id: "llm-completion",
      parent_span_id: midId,
      metadata: metadataWith([rootId, midId], ["demo_session", "agent_turn", "llm_completion"]),
    });

    const result = enrichSpansWithPending([child]);
    const ids = result.map((s) => s.span_id);

    expect(ids).toContain(rootId);
    expect(ids).toContain(midId);
    expect(result.find((s) => s.span_id === rootId)!.pending).toBe(true);
    expect(result.find((s) => s.span_id === midId)!.pending).toBe(true);
    expect(result.find((s) => s.span_id === midId)!.parent_span_id).toBe(rootId);
  });

  it("does not create duplicate placeholders when multiple spans share ancestors", () => {
    const rootId = "root-id";
    const child1 = makeSpan({
      span_id: "child-1",
      parent_span_id: rootId,
      metadata: metadataWith([rootId], ["root", "child-1"]),
    });
    const child2 = makeSpan({
      span_id: "child-2",
      parent_span_id: rootId,
      metadata: metadataWith([rootId], ["root", "child-2"]),
    });

    const result = enrichSpansWithPending([child1, child2]);
    const rootPlaceholders = result.filter((s) => s.span_id === rootId);

    expect(rootPlaceholders).toHaveLength(1);
  });

  it("does not create a placeholder when the parent is already present", () => {
    const parent = makeSpan({ span_id: "parent" });
    const child = makeSpan({
      span_id: "child",
      parent_span_id: "parent",
      metadata: metadataWith(["parent"], ["parent", "child"]),
    });

    const result = enrichSpansWithPending([parent, child]);
    expect(result.filter((s) => s.pending)).toHaveLength(0);
  });

  it("replaces an existing pending span with updated start_time when a child with earlier start arrives", () => {
    const placeholderId = "mid-id";
    const existingPending = makeSpan({
      span_id: placeholderId,
      span_start_time: "2024-01-01T00:00:05.000Z",
      pending: true,
    });
    const child = makeSpan({
      span_id: "child",
      parent_span_id: placeholderId,
      span_start_time: "2024-01-01T00:00:01.000Z",
      metadata: metadataWith([placeholderId], ["mid", "child"]),
    });

    const result = enrichSpansWithPending([existingPending, child]);
    const updated = result.find((s) => s.span_id === placeholderId)!;

    expect(updated.span_start_time).toBe("2024-01-01T00:00:01.000Z");
  });

  it("does not backdate a pending span if existing start_time is already earlier", () => {
    const placeholderId = "mid-id";
    const existingPending = makeSpan({
      span_id: placeholderId,
      span_start_time: "2024-01-01T00:00:01.000Z",
      pending: true,
    });
    const child = makeSpan({
      span_id: "child",
      parent_span_id: placeholderId,
      span_start_time: "2024-01-01T00:00:05.000Z",
      metadata: metadataWith([placeholderId], ["mid", "child"]),
    });

    const result = enrichSpansWithPending([existingPending, child]);
    const updated = result.find((s) => s.span_id === placeholderId)!;

    expect(updated.span_start_time).toBe("2024-01-01T00:00:01.000Z");
  });

  it("skips spans with no metadata or missing ids_path", () => {
    const child = makeSpan({
      span_id: "child",
      parent_span_id: "missing-parent",
      metadata: null,
    });

    const result = enrichSpansWithPending([child]);
    expect(result.filter((s) => s.pending)).toHaveLength(0);
  });

  it("strips existing pending spans from the real spans list before merging", () => {
    // If a real span arrives to replace a pending placeholder, the pending one
    // should not appear in the output alongside the real one.
    const realSpan = makeSpan({ span_id: "s1", pending: false });
    const pendingSpan = makeSpan({ span_id: "s1", pending: true });

    const result = enrichSpansWithPending([pendingSpan, realSpan]);
    const s1s = result.filter((s) => s.span_id === "s1");

    expect(s1s).toHaveLength(1);
    expect(s1s[0].pending).toBeFalsy();
  });
});
