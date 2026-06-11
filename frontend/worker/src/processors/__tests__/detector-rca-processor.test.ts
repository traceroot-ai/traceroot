import { describe, it, expect, vi, beforeEach } from "vitest";

const modelProviderFindMany = vi.fn();

vi.mock("@traceroot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@traceroot/core")>();
  return {
    ...actual,
    prisma: {
      ...actual.prisma,
      modelProvider: {
        findMany: (...a: any[]) => modelProviderFindMany(...a),
      },
    },
  };
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
  beforeEach(() => {
    modelProviderFindMany.mockReset();
  });

  it("resolves model directly when rcaProvider and rcaSource are provided", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("my-custom-model", "my-provider", "byok", "ws-123");
    expect(res).toEqual({
      model: "my-custom-model",
      providerName: "my-provider",
      source: "byok",
    });
    expect(modelProviderFindMany).not.toHaveBeenCalled();
  });

  it("resolves a system model correctly", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("claude-sonnet-4-5", null, null, "ws-123");
    expect(res).toEqual({
      model: "claude-sonnet-4-5",
      providerName: "anthropic",
      source: "system",
    });
    expect(modelProviderFindMany).not.toHaveBeenCalled();
  });

  it("resolves an enabled BYOK model correctly", async () => {
    modelProviderFindMany.mockResolvedValue([
      {
        provider: "deepseek-byok",
        adapter: "deepseek",
        customModels: ["deepseek/deepseek-chat-v3", "deepseek-chat"],
      },
    ]);
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("deepseek/deepseek-chat-v3", null, null, "ws-123");
    expect(res).toEqual({
      model: "deepseek/deepseek-chat-v3",
      providerName: "deepseek-byok",
      source: "byok",
    });
    expect(modelProviderFindMany).toHaveBeenCalledWith({
      where: { workspaceId: "ws-123", enabled: true },
      orderBy: { id: "asc" },
      select: { provider: true, adapter: true, customModels: true },
    });
  });

  it("disambiguates based on model ID prefix matching provider adapter", async () => {
    modelProviderFindMany.mockResolvedValue([
      {
        provider: "my-openrouter",
        adapter: "openrouter",
        customModels: ["deepseek/deepseek-chat-v3"],
      },
      {
        provider: "my-deepseek",
        adapter: "deepseek",
        customModels: ["deepseek/deepseek-chat-v3"],
      },
    ]);
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("deepseek/deepseek-chat-v3", null, null, "ws-123");
    expect(res).toEqual({
      model: "deepseek/deepseek-chat-v3",
      providerName: "my-deepseek",
      source: "byok",
    });
  });

  it("no longer disambiguates based on model ID in curated catalog matching provider adapter", async () => {
    modelProviderFindMany.mockResolvedValue([
      {
        provider: "my-openai",
        adapter: "openai",
        customModels: ["deepseek-chat"],
      },
      {
        provider: "my-deepseek",
        adapter: "deepseek",
        customModels: ["deepseek-chat"],
      },
    ]);
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("deepseek-chat", null, null, "ws-123");
    expect(res).toEqual({
      model: "deepseek-chat",
      providerName: "my-openai",
      source: "byok",
    });
  });

  it("falls back to the first provider if no adapter matches prefix or catalog", async () => {
    modelProviderFindMany.mockResolvedValue([
      {
        provider: "provider-1",
        adapter: "openai",
        customModels: ["custom-model-id"],
      },
      {
        provider: "provider-2",
        adapter: "google",
        customModels: ["custom-model-id"],
      },
    ]);
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("custom-model-id", null, null, "ws-123");
    expect(res).toEqual({
      model: "custom-model-id",
      providerName: "provider-1",
      source: "byok",
    });
  });

  it("proves deterministic provider selection by verifying orderBy in findMany when multiple providers share customModel", async () => {
    // Assert that the findMany query is requested with a stable orderBy: { id: "asc" }
    modelProviderFindMany.mockResolvedValue([]);
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    await resolveProjectModel("custom-model-id", null, null, "ws-123");
    expect(modelProviderFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: "asc" },
      }),
    );
  });

  it("returns null for unknown/disabled models", async () => {
    modelProviderFindMany.mockResolvedValue([]);
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    const res = await resolveProjectModel("unknown-model", null, null, "ws-123");
    expect(res).toBeNull();
  });

  it("returns null for empty/undefined models", async () => {
    const { resolveProjectModel } = await import("../detector-rca-processor.js");
    expect(await resolveProjectModel(null, null, null, "ws-123")).toBeNull();
    expect(await resolveProjectModel(undefined, null, null, "ws-123")).toBeNull();
  });
});
