import { describe, expect, it, vi } from "vitest";

vi.mock("@traceroot/core", () => ({
  escapeHtml: (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  renderEmailCard: (p: { title: string; bodyHtml: string; buttonUrl: string }) =>
    `<card title="${p.title}" button="${p.buttonUrl}">${p.bodyHtml}</card>`,
}));

import {
  buildSignalDigestBlocks,
  buildSignalDigestEmail,
  digestHeadline,
  signalUrl,
} from "../digest-render.js";
import type { DigestItem } from "../digest.js";

const item = (over: Partial<DigestItem> = {}): DigestItem => ({
  signalId: "sig1",
  title: "Timeout <swallowed>",
  detectorId: "det1",
  detectorName: "Failure",
  kind: "new",
  hitCount: 3,
  summary: "The tool error is <returned> as data.",
  ...over,
});

describe("signal digest rendering", () => {
  const items = [
    item(),
    item({ signalId: "sig2", kind: "reopened" }),
    item({ signalId: "sig3", hitCount: 12, summary: "  " }),
  ];

  it("summarises the counts per kind", () => {
    expect(digestHeadline(items, "Shop")).toBe("Signals in Shop: 2 new, 1 reopened");
  });

  it("links each signal to the Signals page that opens it", () => {
    expect(signalUrl("p 1", item())).toBe(
      "http://localhost:3000/projects/p%201/signals?signalId=sig1",
    );
  });

  it("builds Slack sections per kind with escaped titles and the summary, never RCA", () => {
    const blocks = buildSignalDigestBlocks({ projectId: "p1", projectName: "Shop", items }) as {
      type: string;
      text?: { text: string };
    }[];
    const texts = blocks.map((b) => b.text?.text ?? "");
    expect(texts).toContain("*New*");
    expect(texts).toContain("*Reopened*");
    expect(texts.some((t) => t.includes("Ongoing"))).toBe(false);
    const first = texts.find((t) => t.includes("sig1"))!;
    expect(first).toContain("Timeout &lt;swallowed&gt;");
    expect(first).toContain("· Failure · 3 hits");
    expect(first).toContain(">The tool error is &lt;returned&gt; as data.");
    expect(texts.find((t) => t.includes("sig2"))).toContain(">The tool error");
    // A signal without a summary gets no empty quote line.
    expect(texts.find((t) => t.includes("sig3"))).toContain("· 12 hits");
    expect(texts.find((t) => t.includes("sig3"))).not.toContain("\n>");
    expect(texts.some((t) => /RCA|Root cause/.test(t))).toBe(false);
  });

  it("stays under Slack's block limit and says how many were left out", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      item({ signalId: `s${i}`, kind: "reopened" }),
    );
    const blocks = buildSignalDigestBlocks({ projectId: "p", projectName: "P", items: many }) as {
      type: string;
      elements?: { text: string }[];
    }[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.find((b) => b.type === "context")?.elements?.[0].text).toBe("+15 more signals");
  });

  it("lists at most 45 signals in the email and says how many were left out", () => {
    const many = [
      ...Array.from({ length: 30 }, (_, i) => item({ signalId: `n${i}` })),
      ...Array.from({ length: 30 }, (_, i) => item({ signalId: `o${i}`, kind: "reopened" })),
    ];
    const email = buildSignalDigestEmail({ projectId: "p", projectName: "P", items: many });
    expect(email.text.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(45);
    expect(email.text).toContain("+15 more signals");
    expect(email.html).toContain("+15 more signals");
    expect(email.html).not.toContain("signalId=o15");
  });

  it("bounds a long summary in Slack and email", () => {
    const long = item({ summary: "x".repeat(1000) });
    const blocks = buildSignalDigestBlocks({
      projectId: "p",
      projectName: "P",
      items: [long],
    }) as { text?: { text: string } }[];
    const line = blocks.map((b) => b.text?.text ?? "").find((t) => t.includes("sig1"))!;
    expect(line.length).toBeLessThan(600);
    const email = buildSignalDigestEmail({ projectId: "p", projectName: "P", items: [long] });
    expect(email.text).toContain(`  ${"x".repeat(299)}…`);
    expect(email.text).not.toContain("x".repeat(300));
  });

  it("builds the email with the same content, escaped", () => {
    const email = buildSignalDigestEmail({ projectId: "p1", projectName: "Shop <x>", items });
    expect(email.subject).toBe("[TraceRoot] Signals in Shop <x>: 2 new, 1 reopened");
    expect(email.text).toContain("New:\n- Timeout <swallowed> · Failure · 3 hits");
    expect(email.text).toContain(
      "New:\n- Timeout <swallowed> · Failure · 3 hits\n  The tool error is <returned> as data.",
    );
    expect(email.html).toContain("The tool error is &lt;returned&gt; as data.");
    expect(`${email.text}${email.html}`).not.toMatch(/RCA|Root cause/);
    expect(email.html).toContain("Timeout &lt;swallowed&gt;");
    expect(email.html).not.toContain("<swallowed>");
    expect(email.html).toContain('button="http://localhost:3000/projects/p1/signals"');
  });
});
