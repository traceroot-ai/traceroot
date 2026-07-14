import { describe, it, expect } from "vitest";
import {
  buildDigestSummaryPrompt,
  buildDigestSummaryTool,
  DIGEST_SUMMARY_MAX_PROMPT_CHARS,
  type DigestSummaryInput,
} from "../digest-summary.js";

const WINDOW = {
  windowStart: new Date("2026-07-13T19:00:00Z"),
  windowEnd: new Date("2026-07-13T19:10:00Z"),
};

function input(detectors: DigestSummaryInput["detectors"]): DigestSummaryInput {
  return { projectName: "Acme", ...WINDOW, detectors };
}

describe("buildDigestSummaryPrompt", () => {
  it("includes detector name, count, and each sentence", () => {
    const p = buildDigestSummaryPrompt(
      input([{ name: "Failure Detector", findingCount: 2, sampleSummaries: ["a", "b"] }]),
    );
    expect(p).not.toBeNull();
    expect(p!.userText).toContain("Failure Detector");
    expect(p!.userText).toContain("2 findings");
    expect(p!.userText).toContain("- a");
    expect(p!.userText).toContain("- b");
  });

  it("returns null when no detector has any sentences", () => {
    expect(
      buildDigestSummaryPrompt(input([{ name: "D", findingCount: 3, sampleSummaries: [] }])),
    ).toBeNull();
  });

  it("keeps zero-sample detectors with an explicit no-sample disclosure", () => {
    const p = buildDigestSummaryPrompt(
      input([
        { name: "Sampled", findingCount: 2, sampleSummaries: ["a"] },
        { name: "Starved", findingCount: 5, sampleSummaries: [] },
      ]),
    );
    expect(p!.userText).toContain("DETECTOR: Starved — 5 findings (no sample available)");
  });

  it("discloses sampling when findingCount exceeds the sample", () => {
    const p = buildDigestSummaryPrompt(
      input([{ name: "D", findingCount: 3412, sampleSummaries: ["x", "y"] }]),
    );
    expect(p!.userText).toContain("latest 2 of 3412 findings");
  });

  it("drops whole detectors (largest kept first) to stay under the char budget", () => {
    const bigSentence = "s".repeat(300);
    const detectors = Array.from({ length: 80 }, (_, i) => ({
      name: `detector-${i}`,
      findingCount: 80 - i, // detector-0 has the most findings
      sampleSummaries: Array.from({ length: 10 }, () => bigSentence),
    }));
    const p = buildDigestSummaryPrompt(input(detectors));
    expect(p).not.toBeNull();
    expect(p!.userText.length).toBeLessThanOrEqual(DIGEST_SUMMARY_MAX_PROMPT_CHARS);
    expect(p!.userText).toContain("detector-0"); // biggest survives
    expect(p!.userText).not.toContain("detector-79"); // smallest dropped whole
    // Dropped detectors are disclosed so the model doesn't treat the list as complete.
    expect(p!.userText).toMatch(/\+\d+ more detectors omitted/);
  });
});

describe("buildDigestSummaryTool", () => {
  it("requires a single summary string", () => {
    const tool = buildDigestSummaryTool();
    expect(tool.name).toBe("submit_digest_summary");
    expect((tool.parameters as any).required).toEqual(["summary"]);
  });
});
