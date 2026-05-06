import { describe, expect, it } from "vitest";
import { buildCombinedAlertBlocks } from "../block-kit";

const base = {
  detectorName: "Hallucination",
  projectName: "billing-agent",
  summary: "Agent invented a refund policy.",
  traceId: "abcdef1234567890",
  projectId: "proj_1",
  appBaseUrl: "https://app.traceroot.ai",
  rcaResult: "The agent did not have policy context.",
};

describe("buildCombinedAlertBlocks", () => {
  it("includes header, summary, RCA, and View trace button", () => {
    const blocks = buildCombinedAlertBlocks(base);
    const header = blocks.find((b: any) => b.type === "header");
    expect(header?.text.text).toContain("Hallucination");
    const text = JSON.stringify(blocks);
    expect(text).toContain("billing-agent");
    expect(text).toContain("Agent invented a refund policy.");
    expect(text).toContain("The agent did not have policy context.");
    expect(text).toContain(
      "https://app.traceroot.ai/projects/proj_1/traces?traceId=abcdef1234567890",
    );
  });

  it("falls back to a placeholder when rcaResult is null", () => {
    const blocks = buildCombinedAlertBlocks({ ...base, rcaResult: null });
    expect(JSON.stringify(blocks)).toContain("Root cause analysis did not complete");
  });

  it("escapes mrkdwn injection in summary", () => {
    const blocks = buildCombinedAlertBlocks({ ...base, summary: "Pinged <!channel> & friends" });
    const text = JSON.stringify(blocks);
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).toContain("&amp;");
    expect(text).not.toContain("<!channel>");
  });

  it("rewrites markdown links to Slack syntax", () => {
    const blocks = buildCombinedAlertBlocks({
      ...base,
      summary: "See [the docs](https://docs.example.com/x) for context",
    });
    expect(JSON.stringify(blocks)).toContain("<https://docs.example.com/x|the docs>");
  });

  it("truncates section text longer than 3000 chars", () => {
    const long = "x".repeat(3500);
    const blocks = buildCombinedAlertBlocks({ ...base, summary: long });
    const sections = blocks.filter((b: any) => b.type === "section");
    for (const s of sections) {
      expect(s.text.text.length).toBeLessThanOrEqual(3000);
    }
  });
});
