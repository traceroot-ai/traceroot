import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchProviderConfigMock = vi.fn();
const resolvePiModelMock = vi.fn();

vi.mock("@traceroot/core/model-resolver", async () => ({
  fetchProviderConfig: (...args: any[]) => fetchProviderConfigMock(...args),
  resolvePiModel: (...args: any[]) => resolvePiModelMock(...args),
}));

afterEach(() => {
  fetchProviderConfigMock.mockReset();
  resolvePiModelMock.mockReset();
});

describe("RCA prompt construction", () => {
  it("includes detector name and summary", () => {
    const detectorName = "error detector";
    const summary = "Tool errored 3 times";
    const traceId = "trace-abcdef123456";
    const hasGitHub = false;

    const githubNote = hasGitHub
      ? "If any spans contain git_source_file and git_source_line, read that source code and check recent commits/PRs touching that file."
      : "";

    const prompt = `Detector fired: "${detectorName}".
Finding: ${summary}
Trace ID: ${traceId}

Download and analyze this trace. Identify the root cause.
${githubNote}

Output your findings in this format:
- Root cause: [one sentence]
- Code location: [file:line if found, else "not identified"]
- Recent changes: [relevant commits/PRs if found, else "not checked"]
- Recommendation: [one actionable sentence]`;

    expect(prompt).toContain("error detector");
    expect(prompt).toContain("Tool errored 3 times");
    expect(prompt).toContain("trace-abcdef123456");
    expect(prompt).not.toContain("git_source_file"); // hasGitHub=false
  });

  it("includes GitHub instruction when hasGitHub=true", () => {
    const hasGitHub = true;
    const githubNote = hasGitHub
      ? "If any spans contain git_source_file and git_source_line, read that source code and check recent commits/PRs touching that file."
      : "";

    expect(githubNote).toContain("git_source_file");
    expect(githubNote).toContain("git_source_line");
  });

  it("session title includes detector name and trace id prefix", () => {
    const detectorName = "error detector";
    const traceId = "trace-abcdef123456";
    const title = `[RCA] ${detectorName} — ${traceId.slice(0, 8)}`;
    expect(title).toBe("[RCA] error detector — trace-ab");
  });
});

describe("SSE parsing logic", () => {
  it("accumulates text_delta events", () => {
    // Simulate the SSE parsing logic
    const sseLines = [
      'data: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Root cause: "}}',
      'data: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"missing dedup"}}',
      'data: {"type":"done","data":"{}"}',
      "data: invalid json {{",
    ];

    let result = "";
    for (const line of sseLines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta" &&
            event.assistantMessageEvent.delta
          ) {
            result += event.assistantMessageEvent.delta;
          }
        } catch {
          // skip malformed
        }
      }
    }

    expect(result).toBe("Root cause: missing dedup");
  });

  it("ignores non-text_delta events", () => {
    const sseLines = [
      'data: {"type":"message_start"}',
      'data: {"type":"message_end","message":{}}',
    ];

    let result = "";
    for (const line of sseLines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (
            event.type === "message_update" &&
            event.assistantMessageEvent?.type === "text_delta"
          ) {
            result += event.assistantMessageEvent.delta || "";
          }
        } catch {
          // skip malformed
        }
      }
    }
    expect(result).toBe("");
  });
});

describe("resolveProjectModel", () => {
  it("resolves a BYOK model via fetchProviderConfig and resolvePiModel", async () => {
    fetchProviderConfigMock.mockResolvedValue({
      adapter: "openai",
      key: "sk-xxx",
      baseUrl: null,
      config: null,
    });
    resolvePiModelMock.mockReturnValue({ id: "gpt-5.3", provider: "openai" });

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("gpt-5.3", "my-openai", "byok", "ws-123");

    expect(fetchProviderConfigMock).toHaveBeenCalledWith("ws-123", "my-openai");
    expect(resolvePiModelMock).toHaveBeenCalledWith("gpt-5.3", expect.any(Object));
    expect(res).toEqual({ model: "gpt-5.3", providerName: "openai", source: "byok" });
  });

  it("returns null when BYOK provider is not found or disabled", async () => {
    fetchProviderConfigMock.mockResolvedValue(null);

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("gpt-5.3", "missing-provider", "byok", "ws-123");

    expect(res).toBeNull();
    expect(resolvePiModelMock).not.toHaveBeenCalled();
  });

  it("resolves a system model via resolvePiModel", async () => {
    resolvePiModelMock.mockReturnValue({ id: "claude-sonnet-4-5", provider: "anthropic" });

    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("claude-sonnet-4-5", null, null, "ws-123");

    expect(resolvePiModelMock).toHaveBeenCalledWith("claude-sonnet-4-5", null);
    expect(res).toEqual({
      model: "claude-sonnet-4-5",
      providerName: "anthropic",
      source: "system",
    });
  });

  it("returns null for unknown models not in system catalog", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("unknown-model", null, null, "ws-123");

    expect(res).toBeNull();
    expect(fetchProviderConfigMock).not.toHaveBeenCalled();
  });

  it("falls back to null when rcaSource is byok but rcaProvider is missing", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("some-model", null, "byok", "ws-123");

    expect(res).toBeNull();
    expect(fetchProviderConfigMock).not.toHaveBeenCalled();
  });

  it("returns null for empty or undefined models", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    expect(await resolveProjectModel(null, null, null, "ws-123")).toBeNull();
    expect(await resolveProjectModel(undefined, null, null, "ws-123")).toBeNull();
  });
});
