import { describe, expect, it } from "vitest";
import { buildDigestAlertBlocks, escapeMrkdwn, truncate, truncateEscaped } from "../block-kit.ts";

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

  it("never splits the escaped detector name's entity, even in a pathologically long name", () => {
    // a name built entirely of "&" expands well past DETECTOR_NAME_CAP once
    // escaped, so a naive whole-row truncate would land inside one of its
    // "&amp;" entities — the name needs its own cap, applied before the row
    // mixes it with the row's raw URL text.
    const blocks = buildDigestAlertBlocks({
      ...digestBase,
      total: 1,
      entries: [
        {
          detectorId: "d1",
          detectorName: "&".repeat(2500),
          findingCount: 1,
          latestTraceId: "a1b2c3d4",
        },
      ],
    }) as any[];
    const row = blocks[2].text.text as string; // header, divider, detector row
    expect(row.includes("…")).toBe(true);
    expect(row).not.toMatch(/&[a-z]*…/);
    // the row's own URL separators are untouched by the name's cap
    expect(row).toContain("date_filter=custom&start=");
  });

  it("caps detector lines at the Slack 50-block limit and notes the overflow", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({
      detectorId: `d${i}`,
      detectorName: `Detector ${i}`,
      findingCount: 1,
      latestTraceId: `trace${i}`,
    }));
    const blocks = buildDigestAlertBlocks({ ...digestBase, total: 50, entries });

    // never exceeds Slack's hard 50-block cap
    expect(blocks.length).toBeLessThanOrEqual(50);
    // 45 detector lines listed, the 46th line is the overflow note for the rest
    expect(JSON.stringify(blocks)).toContain("_+5 more detectors_");
    expect(JSON.stringify(blocks)).toContain("Detector 44");
    expect(JSON.stringify(blocks)).not.toContain("Detector 45");
    // the footer still reports the true total detector count
    const footer = blocks.find((b: any) => b.type === "context") as any;
    expect(footer.elements[0].text).toContain("50 detectors");
  });

  it("renders all detectors without an overflow note at the block-budget boundary", () => {
    const entries = Array.from({ length: 46 }, (_, i) => ({
      detectorId: `d${i}`,
      detectorName: `Detector ${i}`,
      findingCount: 1,
      latestTraceId: `trace${i}`,
    }));
    const blocks = buildDigestAlertBlocks({ ...digestBase, total: 46, entries });

    expect(blocks.length).toBe(50);
    expect(JSON.stringify(blocks)).not.toContain("more detector");
    expect(JSON.stringify(blocks)).toContain("Detector 45");
  });

  it("renders the summary as the first section under the header, escaped and capped", () => {
    const withSummary = buildDigestAlertBlocks({
      ...digestBase,
      summary: "Payments <charge> is down & retrying.",
    });
    const without = buildDigestAlertBlocks(digestBase);
    expect(withSummary.length).toBe(without.length + 1);
    const summaryBlock = withSummary[2] as any; // header, divider, summary
    expect(summaryBlock.type).toBe("section");
    expect(summaryBlock.text.text).toBe("Payments &lt;charge&gt; is down &amp; retrying.");

    const long = buildDigestAlertBlocks({ ...digestBase, summary: "x".repeat(2000) }) as any[];
    expect(long[2].text.text.length).toBeLessThanOrEqual(700);
    expect(long[2].text.text.endsWith("…")).toBe(true);
  });

  it("emits identical blocks when summary is absent or blank", () => {
    expect(buildDigestAlertBlocks({ ...digestBase, summary: "   " })).toEqual(
      buildDigestAlertBlocks(digestBase),
    );
  });

  it("stays within 50 blocks when a summary is present at the overflow boundary", () => {
    const entries = Array.from({ length: 46 }, (_, i) => ({
      detectorId: `d${i}`,
      detectorName: `Detector ${i}`,
      findingCount: 1,
      latestTraceId: `trace${i}`,
    }));
    // 46 entries + summary: the summary eats one line slot -> exactly 50
    // blocks total, with an overflow note for the two displaced rows.
    const withSummary = buildDigestAlertBlocks({
      ...digestBase,
      total: 46,
      entries,
      summary: "S.",
    }) as any[];
    expect(withSummary.length).toBe(50);
    expect(JSON.stringify(withSummary)).toContain("+2 more detectors");
    // 46 entries without summary: fits exactly, 50 blocks, no overflow note.
    const without = buildDigestAlertBlocks({ ...digestBase, total: 46, entries }) as any[];
    expect(without.length).toBe(50);
    expect(JSON.stringify(without)).not.toContain("more detectors");
  });

  it("omits the latest-trace link when an entry has no latest trace", () => {
    const text = JSON.stringify(
      buildDigestAlertBlocks({
        ...digestBase,
        total: 1,
        entries: [
          { detectorId: "d1", detectorName: "Latency", findingCount: 1, latestTraceId: "" },
        ],
      }),
    );
    expect(text).toContain("Latency");
    expect(text).not.toContain("latest:");
  });

  it("keeps a real trailing ampersand in a truncated raw header, not just an escaped one", () => {
    // the header is built from a raw (unescaped) project name, so a cut that
    // lands right after a genuine "&word" in it must leave that text alone —
    // it is not a split escapeMrkdwn entity, and stripping it would delete
    // real content the project actually named itself.
    const blocks = buildDigestAlertBlocks({
      ...digestBase,
      projectName: "checkout" + "&svc".repeat(33),
    }) as any[];
    const header = blocks[0];
    expect(header.text.text).toHaveLength(150);
    expect(header.text.text.endsWith("&sv…")).toBe(true);
  });
});

describe("truncate", () => {
  it("leaves text under the limit untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("cuts and marks plain text with an ellipsis", () => {
    expect(truncate("x".repeat(10), 5)).toBe("xxxx…");
  });

  it("does not touch a raw ampersand — it is not an escape entity here", () => {
    // truncate is for raw text (URLs, plain_text fields, …): a trailing "&x"
    // is ordinary content, e.g. a URL's own "&start=" separator, not a
    // truncated "&amp;". Stripping it would delete real text for no reason —
    // that cleanup belongs to truncateEscaped, only safe after escapeMrkdwn.
    expect(truncate("date_filter=custom&start=2026", 25)).toBe("date_filter=custom&start…");
  });
});

describe("truncateEscaped", () => {
  it("leaves text under the limit untouched", () => {
    expect(truncateEscaped("hello", 10)).toBe("hello");
  });

  it("drops a trailing partial escape entity instead of splitting it", () => {
    // escaped "&" becomes "&amp;" (5 chars): a cut at max=4 over "a&" lands
    // the boundary inside it, at "a&a" — the fix drops the dangling "&a".
    const escaped = escapeMrkdwn("a&");
    expect(escaped).toBe("a&amp;");
    expect(truncateEscaped(escaped, 4)).toBe("a…");

    // a cut that lands exactly after a complete entity leaves it whole
    expect(truncateEscaped(escapeMrkdwn("a&") + "bcdef", 7)).toBe("a&amp;…");
  });
});
