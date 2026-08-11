import { describe, it, expect } from "vitest";
import { getSystemPrompt } from "../system.js";

describe("getSystemPrompt", () => {
  it("includes project ID", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("proj-123");
  });

  it("describes the registry read tools", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("list_traces");
    expect(prompt).toContain("search and filter traces");
    expect(prompt).toContain("list_sessions");
    expect(prompt).toContain("get_session");
  });

  it("describes download_trace tool", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("download_trace");
    expect(prompt).toContain("trace.jsonl");
    expect(prompt).toContain("tree.json");
    expect(prompt).toContain("spans.jsonl");
  });

  it("describes the detector read tools", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("list_detectors");
    expect(prompt).toContain("get_detector with a detector_id");
    expect(prompt).toContain("list_findings");
    expect(prompt).toContain("get_finding");
    expect(prompt).toContain("get_finding_by_trace");
    expect(prompt).toContain("root-cause analysis");
  });

  it("lists the detector templates so coverage gaps get template recommendations", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("failure, hallucination, logic, task, safety");
    expect(prompt).toContain("blank (fully custom prompt)");
    expect(prompt).toContain("recommend adding a detector with the");
  });

  it("tells the agent telemetry is live so counts get re-queried, not recalled", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("Telemetry is live");
    expect(prompt).toContain("re-run the query instead of answering from earlier results");
    expect(prompt).toContain("don't invent filter explanations");
  });

  it("points a session context at get_session and download_session", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123", traceSessionId: "sess-9" });
    expect(prompt).toContain("Currently viewing Session ID: sess-9");
    expect(prompt).toContain("Call get_session with this session_id");
    expect(prompt).toContain("Call download_session with this sessionId");
  });

  it("includes ClickHouse schema reference", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    expect(prompt).toContain("observations table");
    expect(prompt).toContain("GENERATION|SPAN|EVENT");
  });

  it("includes current date in UTC", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    expect(prompt).toContain("Current date:");
    expect(prompt).toContain(today);
    expect(prompt).toContain("UTC");
  });
});
