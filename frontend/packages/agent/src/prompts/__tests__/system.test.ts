import { describe, it, expect } from "vitest";
import { getSystemPrompt } from "../system.js";

describe("getSystemPrompt", () => {
  it("includes project ID", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("proj-123");
  });

  it("describes query_traces tool", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("query_traces");
    expect(prompt).toContain("search and filter traces");
  });

  it("describes download_trace tool", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("download_trace");
    expect(prompt).toContain("trace.jsonl");
    expect(prompt).toContain("tree.json");
    expect(prompt).toContain("spans.jsonl");
  });

  it("includes ClickHouse schema reference", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("observations table");
    expect(prompt).toContain("GENERATION|SPAN|EVENT");
  });

  it("escapes trace and session IDs before embedding them", () => {
    const prompt = getSystemPrompt({
      projectId: "proj-123",
      traceId: 'trace-1"\n- injected',
      traceSessionId: 'session-1"\n- injected',
    });
    expect(prompt).toContain('Currently viewing Trace ID: "trace-1\\"\\n- injected"');
    expect(prompt).toContain('Currently viewing Session ID: "session-1\\"\\n- injected"');
    expect(prompt).not.toContain('Trace ID: trace-1"\n- injected');
    expect(prompt).not.toContain('Session ID: session-1"\n- injected');
  });

  it("caps opaque context IDs before embedding them", () => {
    const prompt = getSystemPrompt({
      projectId: "proj-123",
      traceId: "t".repeat(600),
    });
    expect(prompt).toContain(`Currently viewing Trace ID: "${"t".repeat(512)}"`);
    expect(prompt).not.toContain("t".repeat(513));
  });
});
