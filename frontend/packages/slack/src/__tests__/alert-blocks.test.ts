import { describe, expect, it } from "vitest";
import type { AlertSeverity, AlertThresholdOperator } from "@traceroot/core";
import { ALERT_SEVERITY_COLORS, buildAlertBlocks } from "../alert-blocks.ts";

const alertBase = {
  appBaseUrl: "https://app.example.test",
  projectId: "proj_1",
  alertId: "al_1",
  name: "Checkout p95 latency",
  severity: "ALERT" as AlertSeverity,
  previousSeverity: "OK" as AlertSeverity,
  value: 1834.567,
  threshold: 1500,
  thresholdOperator: ">" as AlertThresholdOperator,
  measure: "latency",
  aggregation: "p95",
  window: "30m",
  windowStart: new Date("2026-06-23T12:00:00.000Z"),
  windowEnd: new Date("2026-06-23T12:30:00.000Z"),
};

const SPANS_PATH = "/projects/proj_1/traces?date_filter=custom";

const sectionTexts = (message: { blocks: unknown[] }) =>
  (message.blocks as any[]).filter((b) => b.type === "section").map((b) => b.text.text as string);

// Hue of a #rrggbb colour, for the "nothing purple" check.
const hueOf = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  if (delta === 0) return 0;
  const raw = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta;
  return (raw * 60 + 360) % 360;
};

describe("buildAlertBlocks", () => {
  it("states the observed value, not only the threshold, on a breach and a recovery", () => {
    // the measured number is the point of the message; the threshold alone is not enough
    const breachMessage = buildAlertBlocks(alertBase);
    expect(sectionTexts(breachMessage)[0]).toContain(
      "`p95(latency)` was 1834.57ms, above the 1500ms threshold, over the last 30m.",
    );
    expect(breachMessage.text).toContain("1834.57ms");

    const recovered = { ...alertBase, severity: "OK" as const, previousSeverity: "ALERT" as const };
    expect(sectionTexts(buildAlertBlocks({ ...recovered, value: 900 }))[0]).toContain(
      "`p95(latency)` recovered to 900ms, back within the 1500ms threshold, over the last 30m.",
    );
    // a measured zero is a value, not a fall-through to no data
    const [zero] = sectionTexts(buildAlertBlocks({ ...recovered, value: 0 }));
    expect(zero).toContain("recovered to 0ms");
    expect(zero).not.toContain("No data");

    // one operator stands for the phrase table, and a self-describing measure
    // carries no unit suffix while the raw field id rides in the call form
    const [counted] = sectionTexts(
      buildAlertBlocks({
        ...alertBase,
        measure: "span_count",
        aggregation: "count",
        value: 12,
        thresholdOperator: "<=",
      }),
    );
    expect(counted).toContain("`count(span_count)` was 12, at or below the 1500 threshold");
    expect(counted).not.toContain("12ms");
  });

  it("names the row-count pseudo-measure once when aggregation and measure coincide", () => {
    const [outcome] = sectionTexts(
      buildAlertBlocks({
        ...alertBase,
        severity: "OK",
        previousSeverity: "ALERT",
        measure: "count",
        aggregation: "count",
        value: 131,
        threshold: 500,
        window: "10m",
      }),
    );
    expect(outcome).not.toContain("count count");
    expect(outcome).not.toContain("count(count)");
    expect(outcome).toContain(
      "`count` recovered to 131, back within the 500 threshold, over the last 10m.",
    );
  });

  it("does not claim a threshold was crossed when the window produced no data", () => {
    const [noData] = sectionTexts(
      buildAlertBlocks({ ...alertBase, severity: "NO_DATA", previousSeverity: "OK", value: null }),
    );
    expect(noData).toContain("No data for `p95(latency)`");
    expect(noData).toContain("could not be evaluated");
    expect(noData).not.toMatch(/\b(above|below|at or|equal to|back within)\b/);
    expect(noData).not.toContain("null");
  });

  it("reads a null value under ALERT or OK as ZERO mode's measured zero, not as no data", () => {
    // ZERO mode compares an empty window to the threshold as 0 but stores no
    // value, so the breach sentence must still name the zero it judged
    const dropped = buildAlertBlocks({
      ...alertBase,
      measure: "count",
      aggregation: "count",
      value: null,
      threshold: 10,
      thresholdOperator: "<" as AlertThresholdOperator,
    });
    const [outcome, links] = sectionTexts(dropped);
    expect(outcome).toContain("`count` was 0, below the 10 threshold, over the last 30m.");
    expect(outcome).not.toContain("No data");
    expect(outcome).not.toContain("null");
    // for a traffic drop the empty window is the evidence, so the spans link stays
    expect(links).toContain("date_filter=custom");
    expect(links).toContain("|View spans>");

    // the unit suffix rides on the zero the same way it rides on any value
    const recovered = buildAlertBlocks({
      ...alertBase,
      severity: "OK" as const,
      previousSeverity: "ALERT" as const,
      value: null,
    });
    expect(sectionTexts(recovered)[0]).toContain(
      "`p95(latency)` recovered to 0ms, back within the 1500ms threshold, over the last 30m.",
    );
    expect(recovered.text).not.toContain("No data");
  });

  it("omits the data deep-link whenever the window holds nothing to show", () => {
    for (const severity of ["OK", "NO_DATA", "UNKNOWN"] as const) {
      const value = severity === "NO_DATA" ? null : 900;
      const rendered = JSON.stringify(buildAlertBlocks({ ...alertBase, severity, value }));
      expect({ severity, spans: rendered.includes("date_filter=custom") }).toMatchObject({
        spans: false,
      });
      // the permalink to the rule itself still rides on every message
      expect(rendered).toContain("|View alert>");
    }
  });

  it("escapes mrkdwn in rendered prose while leaving link URLs intact", () => {
    const message = buildAlertBlocks({ ...alertBase, measure: "latency <!channel> & co" });
    const [outcome, links] = sectionTexts(message);
    expect(outcome).toContain("&lt;!channel&gt;");
    expect(outcome).toContain("&amp; co");
    expect(outcome).not.toContain("<!channel>");
    // a breach carries both links, and the URL's own separators survive:
    // escaping them would break the link
    expect(links).toContain("|View alert>");
    expect(links).toContain(
      `${SPANS_PATH}&start=2026-06-23T12%3A00%3A00.000Z&end=2026-06-23T12%3A30%3A00.000Z|View traces>`,
    );
    expect(links).not.toContain("&amp;start=");

    // an id carrying a space or a slash is percent-encoded, not left to break the path
    const encoded = sectionTexts(
      buildAlertBlocks({ ...alertBase, projectId: "a b/c", alertId: "x?y" }),
    )[1];
    expect(encoded).toContain("/projects/a%20b%2Fc/alerts/x%3Fy|View alert>");
    expect(encoded).toContain("/projects/a%20b%2Fc/traces?date_filter=custom");
  });

  it("escapes the alert name in the fallback text so a name cannot broadcast", () => {
    const broadcast = buildAlertBlocks({ ...alertBase, name: "<!channel> checkout down" });
    expect(broadcast.text).toContain("&lt;!channel&gt; checkout down");
    expect(broadcast.text).not.toContain("<!channel>");

    // every metacharacter a name can carry, not only the broadcast token
    const metacharacters = buildAlertBlocks({ ...alertBase, name: "a < b > c & d" });
    expect(metacharacters.text).toContain("a &lt; b &gt; c &amp; d");
    expect(metacharacters.text).not.toMatch(/[<>]/);

    // the header is plain_text, which Slack does not parse
    const header = (broadcast.blocks as any[])[0];
    expect(header.text.type).toBe("plain_text");
    expect(header.text.text).toBe("[ALERT] <!channel> checkout down");
  });

  it("titles by severity, laying out header, outcome, links and a UTC window footer", () => {
    const message = buildAlertBlocks(alertBase);
    const blocks = message.blocks as any[];
    expect(blocks.map((b) => b.type)).toEqual(["header", "section", "section", "context"]);
    expect(blocks[3].elements[0].text).toBe("Jun 23, 12:00–12:30 UTC · OK to ALERT");
    expect(message.text.startsWith("[ALERT] Checkout p95 latency — ")).toBe(true);
  });

  it("truncates to Slack's per-block limits without malforming any block", () => {
    const message = buildAlertBlocks({ ...alertBase, name: "N".repeat(400) });
    const header = (message.blocks as any[])[0];
    expect(header.text.text).toHaveLength(150);
    expect(header.text.text.endsWith("…")).toBe(true);
    expect(message.text).toHaveLength(300);

    const [outcome] = sectionTexts(buildAlertBlocks({ ...alertBase, measure: "m".repeat(4000) }));
    expect(outcome).toHaveLength(3000);
  });

  it("colours the attachment by severity, with nothing purple and no emoji anywhere", () => {
    expect(buildAlertBlocks(alertBase).color).toBe(ALERT_SEVERITY_COLORS.ALERT);
    // a breach reads red and a recovery green; the two non-assertions share one neutral
    expect(hueOf(ALERT_SEVERITY_COLORS.ALERT)).toBeLessThan(20);
    expect(hueOf(ALERT_SEVERITY_COLORS.OK)).toBeGreaterThan(90);
    expect(hueOf(ALERT_SEVERITY_COLORS.OK)).toBeLessThan(180);
    for (const color of Object.values(ALERT_SEVERITY_COLORS)) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
      const hue = hueOf(color);
      expect({ color, isPurple: hue >= 255 && hue <= 330 }).toMatchObject({ isPurple: false });
    }

    const pictographic = /\p{Extended_Pictographic}/u;
    for (const noData of [false, true]) {
      // the fallback text is a separate render, and it is what the notification shows
      const message = buildAlertBlocks({
        ...alertBase,
        severity: noData ? "NO_DATA" : "ALERT",
        value: noData ? null : 1834.567,
      });
      expect(JSON.stringify(message.blocks)).not.toMatch(pictographic);
      expect(message.text).not.toMatch(pictographic);
    }
  });
  it("states the rule's filters in the prose and carries the expressible ones in the link", () => {
    const filtered = buildAlertBlocks({
      ...alertBase,
      filters: [
        { field: "span_kind", op: "=", value: "LLM" },
        { field: "metadata", key: "tenant", op: "contains", value: "acme" },
        // `contains` on a categorical field has no trace-list operator: prose only
        { field: "model_name", op: "contains", value: "gpt" },
        // no trace-list counterpart at all: prose only
        { field: "is_root", op: "=", value: "true" },
      ],
    });
    const [outcome, links] = sectionTexts(filtered);
    // every filter is named, in the rule's order, whether or not the link can carry it
    expect(outcome).toContain(
      "Where `span_kind = LLM` and `metadata[tenant] contains acme` and `model_name contains gpt` and `is_root = true`.",
    );
    // the fallback carries the clause too, for clients that render no blocks
    expect(filtered.text).toContain("Where `span_kind = LLM` and");

    const url = links.match(/<([^|]+)\|View traces>/)![1];
    const filtersParam = new URL(url).searchParams.get("filters");
    expect(JSON.parse(filtersParam!)).toEqual([
      { field: "span_kind", op: "in", value: ["LLM"] },
      { field: "metadata", key: "tenant", op: "contains", value: "acme" },
    ]);
    // the window range still frames the link
    expect(url).toContain("date_filter=custom&start=2026-06-23T12%3A00%3A00.000Z");
  });

  it("keeps a backtick in a filter value from closing the code span", () => {
    const message = buildAlertBlocks({
      ...alertBase,
      filters: [{ field: "name", op: "=", value: "tick`*bold*`tock" }],
    });
    const [outcome] = sectionTexts(message);
    // exactly one code span, the look-alike standing in for each backtick
    const where = outcome.slice(outcome.indexOf("Where "));
    expect(where).toBe("Where `name = tickʼ*bold*ʼtock`.");
    expect(where.split("`").length - 1).toBe(2);
  });

  it("omits the filter clause and the filters param when the rule has none", () => {
    for (const filters of [undefined, []]) {
      const message = buildAlertBlocks({ ...alertBase, filters });
      const [outcome, links] = sectionTexts(message);
      expect(outcome).not.toContain("Where");
      expect(links).not.toContain("filters=");
    }
  });

  it("escapes a filter value in the prose without corrupting the encoded link", () => {
    const message = buildAlertBlocks({
      ...alertBase,
      filters: [{ field: "name", op: "=", value: "<!channel> & co" }],
    });
    const [outcome, links] = sectionTexts(message);
    expect(outcome).toContain("`name = &lt;!channel&gt; &amp; co`");
    expect(outcome).not.toContain("<!channel>");
    const url = links.match(/<([^|]+)\|View traces>/)![1];
    expect(JSON.parse(new URL(url).searchParams.get("filters")!)).toEqual([
      { field: "name", op: "in", value: ["<!channel> & co"] },
    ]);
  });
});
