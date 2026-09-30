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
  newHits: 3,
  rca: { state: "done", rootCause: "the tool error is returned as data" },
  ...over,
});

describe("signal digest rendering", () => {
  const items = [
    item(),
    item({ signalId: "sig2", kind: "reopened", rca: { state: "failed", rootCause: null } }),
    item({ signalId: "sig3", kind: "ongoing", hitCount: 12, newHits: 4, rca: null }),
  ];

  it("summarises the counts per kind", () => {
    expect(digestHeadline(items, "Shop")).toBe("Signals in Shop: 1 new, 1 reopened, 1 ongoing");
  });

  it("links each signal on its detector page", () => {
    expect(signalUrl("p 1", item())).toBe(
      "http://localhost:3000/projects/p%201/detectors/det1?signal=sig1",
    );
  });

  it("builds Slack sections per kind with escaped titles and the RCA line", () => {
    const blocks = buildSignalDigestBlocks({ projectId: "p1", projectName: "Shop", items }) as {
      type: string;
      text?: { text: string };
    }[];
    const texts = blocks.map((b) => b.text?.text ?? "");
    expect(texts).toContain("*New*");
    expect(texts).toContain("*Reopened*");
    expect(texts).toContain("*Ongoing*");
    const first = texts.find((t) => t.includes("sig1"))!;
    expect(first).toContain("Timeout &lt;swallowed&gt;");
    expect(first).toContain("· Failure · 3 hits");
    expect(first).toContain(">Root cause: the tool error is returned as data");
    expect(texts.find((t) => t.includes("sig2"))).toContain(">RCA failed");
    expect(texts.find((t) => t.includes("sig3"))).toContain("+4 since the last digest (12 hits)");
  });

  it("stays under Slack's block limit and says how many were left out", () => {
    const many = Array.from({ length: 60 }, (_, i) => item({ signalId: `s${i}`, kind: "ongoing" }));
    const blocks = buildSignalDigestBlocks({ projectId: "p", projectName: "P", items: many }) as {
      type: string;
      elements?: { text: string }[];
    }[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.find((b) => b.type === "context")?.elements?.[0].text).toBe("+16 more signals");
  });

  it("builds the email with the same content, escaped", () => {
    const email = buildSignalDigestEmail({ projectId: "p1", projectName: "Shop <x>", items });
    expect(email.subject).toBe("[TraceRoot] Signals in Shop <x>: 1 new, 1 reopened, 1 ongoing");
    expect(email.text).toContain("New:\n- Timeout <swallowed> · Failure · 3 hits");
    expect(email.text).toContain("  Root cause: the tool error is returned as data");
    expect(email.html).toContain("Timeout &lt;swallowed&gt;");
    expect(email.html).not.toContain("<swallowed>");
    expect(email.html).toContain('button="http://localhost:3000/projects/p1/detectors"');
  });
});
