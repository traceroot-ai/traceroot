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

  it("includes current date in UTC", () => {
    const prompt = getSystemPrompt({ projectId: "proj-123" });
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    expect(prompt).toContain("Current date:");
    expect(prompt).toContain(today);
    expect(prompt).toContain("UTC");
  });
});
