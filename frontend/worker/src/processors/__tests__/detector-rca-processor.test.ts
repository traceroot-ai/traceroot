import { describe, it, expect } from "vitest";

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
