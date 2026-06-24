import { describe, expect, it } from "vitest";
import { buildCombinedAlertBlocks, buildDigestAlertBlocks } from "../block-kit.ts";

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

const digestBase = {
  projectId: "proj_1",
  projectName: "checkout-svc",
  appBaseUrl: "https://app.example.test",
  windowStart: new Date("2026-06-23T12:00:00.000Z"),
  windowEnd: new Date("2026-06-23T12:30:00.000Z"),
  total: 5,
  entries: [
    {
      detectorId: "d1",
      detectorName: "Latency regression",
      findingCount: 4,
      latestTraceId: "a1b2c3d4",
    },
    {
      detectorId: "d2",
      detectorName: "PII leak check",
      findingCount: 1,
      latestTraceId: "ffee0011",
    },
  ],
};

describe("buildDigestAlertBlocks", () => {
  it("uses a plural header and one line per detector with a window-filtered deep-link", () => {
    const text = JSON.stringify(buildDigestAlertBlocks(digestBase));
    expect(text).toContain("5 findings");
    expect(text).toContain("checkout-svc");
    expect(text).toContain("Latency regression");
    // the representative finding is labelled "latest" (most recent), not "top"
    expect(text).toContain("· latest: <");
    expect(text).not.toContain("· top:");
    // deep-link carries the window start/end as ISO custom range
    expect(text).toContain(
      "/projects/proj_1/detectors/d1?date_filter=custom&start=2026-06-23T12%3A00%3A00.000Z&end=2026-06-23T12%3A30%3A00.000Z",
    );
  });

  it("groups content with dividers and a window/detector-count context footer", () => {
    const blocks = buildDigestAlertBlocks(digestBase);
    expect(blocks.filter((b: any) => b.type === "divider")).toHaveLength(2);
    const footer = blocks.find((b: any) => b.type === "context") as any;
    expect(footer).toBeTruthy();
    const footerText = footer.elements[0].text;
    // same-day window collapses to one date; UTC keeps it unambiguous
    expect(footerText).toContain("Jun 23");
    expect(footerText).toContain("12:00");
    expect(footerText).toContain("12:30");
    expect(footerText).toContain("UTC");
    expect(footerText).toContain("2 detectors");
  });

  it("footer spans both dates for a window that crosses midnight (UTC)", () => {
    const blocks = buildDigestAlertBlocks({
      ...digestBase,
      windowStart: new Date("2026-06-23T23:50:00.000Z"),
      windowEnd: new Date("2026-06-24T00:20:00.000Z"),
    });
    const footer = blocks.find((b: any) => b.type === "context") as any;
    expect(footer.elements[0].text).toContain("Jun 23");
    expect(footer.elements[0].text).toContain("Jun 24");
  });

  it("uses a singular header for a single finding", () => {
    const text = JSON.stringify(
      buildDigestAlertBlocks({
        ...digestBase,
        total: 1,
        entries: [digestBase.entries[1]],
      }),
    );
    expect(text).toContain("1 finding in");
    expect(text).not.toContain("1 findings");
    expect(text).toContain("1 detector");
    expect(text).not.toContain("1 detectors");
  });

  it("escapes mrkdwn injection in the detector name but leaves the deep-link intact", () => {
    const text = JSON.stringify(
      buildDigestAlertBlocks({
        ...digestBase,
        total: 1,
        entries: [
          {
            detectorId: "d1",
            detectorName: "Pinged <!channel> & co",
            findingCount: 1,
            latestTraceId: "a1b2c3d4",
          },
        ],
      }),
    );
    // user-controlled text is escaped...
    expect(text).toContain("&lt;!channel&gt;");
    expect(text).not.toContain("<!channel>");
    // ...while the URL's own query separators survive (not over-escaped to &amp;)
    expect(text).toContain("date_filter=custom&start=");
  });
});
