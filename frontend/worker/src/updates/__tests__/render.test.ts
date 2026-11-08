import { describe, expect, it } from "vitest";
import type { UpdateResult } from "@traceroot/core/updates";
import { renderEmail, renderSlack, type RenderContext } from "../render.js";

const ctx: RenderContext = {
  appBaseUrl: "http://app.example.com/",
  projectId: "proj-1",
  projectName: "Support <bot> & co",
  windowStart: new Date("2026-10-26T09:00:00Z"),
  windowEnd: new Date("2026-11-02T09:00:00Z"),
  frequency: "weekly",
};

const item = (text: string, url = "http://app.example.com/projects/proj-1/traces?traceId=abc") => ({
  text,
  evidence: [{ kind: "trace" as const, label: "Failing traces", url }],
});

const result: UpdateResult = {
  nothingToReport: false,
  headline: "Error rate on research_agent rose from 2.9% to 14.6% (7 of 240 to 35 of 240 traces).",
  summary: "Window 26 Oct to 2 Nov compared with 19 Oct to 26 Oct.",
  sections: [
    {
      id: "shifts",
      title: "Shifts",
      items: [
        item("checkout_agent traces fell from 300 to 120."),
        item("gpt-4o cost rose from $0.90 to $3.15."),
      ],
    },
    {
      id: "signals",
      title: "Signals",
      items: [item("2 new signals, 1 resolved, 1 spiking (40 hits, was 5).")],
    },
  ],
  suggestedDetectors: [
    {
      name: "Refund tool errors",
      checks: "Flags traces where refund_lookup returns a server error.",
    },
  ],
  notesForNextRun: "",
};

const numbers = (text: string) =>
  new Set(text.match(/\d[\d,.]*/g)?.map((n) => n.replace(/[.,]$/, "")) ?? []);

describe("Slack rendering", () => {
  const slack = renderSlack(result, ctx);

  it("puts the headline first, alone, and the details in a thread", () => {
    expect(slack.headline.text).toContain("Error rate on research_agent rose");
    expect(JSON.stringify(slack.headline.blocks)).not.toContain("checkout_agent");
    expect(JSON.stringify(slack.thread)).toContain("checkout_agent traces fell from 300 to 120");
    expect(slack.thread.length).toBeGreaterThan(0);
  });

  it("escapes Slack control characters in names and text", () => {
    const text = JSON.stringify(slack.headline.blocks);
    expect(text).toContain("Support &lt;bot&gt; &amp; co");
    expect(text).not.toContain("<bot>");
  });

  it("links the evidence and the project", () => {
    const text = JSON.stringify(slack.thread);
    expect(text).toContain(
      "<http://app.example.com/projects/proj-1/traces?traceId=abc|Failing traces>",
    );
    expect(JSON.stringify(slack.headline.blocks)).toContain(
      "http://app.example.com/projects/proj-1",
    );
  });

  it("splits a long result into several thread posts within Slack's block limit", () => {
    const many: UpdateResult = {
      ...result,
      sections: [
        {
          id: "shifts",
          title: "Shifts",
          items: Array.from({ length: 12 }, (_, i) => item(`item ${i}`)),
        },
      ],
    };
    const rendering = renderSlack(many, ctx);
    for (const post of rendering.thread) expect(post.blocks.length).toBeLessThanOrEqual(40);
  });

  it("neutralises a label or url that would break out of the link", () => {
    const hostile: UpdateResult = {
      ...result,
      sections: [
        {
          id: "shifts",
          title: "S",
          items: [item("x", "http://a.example.com/x>|<http://evil.example.com")],
        },
      ],
    };
    const text = JSON.stringify(renderSlack(hostile, ctx).thread);
    expect(text).not.toContain("|<http://evil");
  });
});

describe("email rendering", () => {
  const email = renderEmail(result, ctx);

  it("has a subject, HTML and plain text", () => {
    expect(email.subject).toContain("Error rate on research_agent rose");
    expect(email.html).toContain("<!DOCTYPE html>");
    expect(email.text).toContain("SHIFTS");
  });

  it("escapes HTML in names and text", () => {
    expect(email.html).toContain("Support &lt;bot&gt; &amp; co");
    expect(email.html).not.toContain("<bot>");
    const hostile = renderEmail({ ...result, headline: "<script>alert(1)</script>" }, ctx);
    expect(hostile.html).not.toContain("<script>alert(1)</script>");
  });

  it("carries the same numbers as Slack, because both come from one result", () => {
    const slack = renderSlack(result, ctx);
    const slackText = [slack.headline.text, JSON.stringify(slack.thread)].join(" ");
    const resultNumbers = numbers(
      JSON.stringify([result.headline, result.summary, result.sections]),
    );
    for (const n of resultNumbers) {
      expect(slackText).toContain(n);
      expect(email.text).toContain(n);
    }
  });
});
