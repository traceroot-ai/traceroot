import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import { formatWindowRange } from "@traceroot/slack";

export interface DigestSummaryDetectorInput {
  name: string;
  findingCount: number;
  sampleSummaries: string[];
}

export interface DigestSummaryInput {
  projectName: string;
  windowStart: Date;
  windowEnd: Date;
  detectors: DigestSummaryDetectorInput[];
}

// Hard budget on the assembled user text. The ClickHouse caps (10/detector,
// 40 total, 300 chars each) already bound this to ~13k worst case; the budget
// is belt-and-suspenders against cap drift between backend and worker. When
// exceeded we drop WHOLE detectors (never mid-sentence truncation) and
// disclose the omission to the model.
export const DIGEST_SUMMARY_MAX_PROMPT_CHARS = 16_000;

const SYSTEM_PROMPT = `You write one short alert summary for an on-call engineer from AI-detector findings on production traces.

RULES:
- You MUST call the submit_digest_summary tool to answer. Plain text responses are rejected.
- 2-4 plain sentences, roughly 50-80 words. No markdown, no bullet points.
- The FIRST sentence must stand alone: lead with severity/blast radius. Never open with the time window or "during this period".
- One detector with similar findings -> 1-2 sentences. Heterogeneous findings -> up to 4, cross-cutting read first, most severe first.
- Do not enumerate detector names and counts (the alert already lists them); add only what the list cannot say.
- When told the sentences are a sample of a larger count, do not claim they represent everything.`;

function detectorSection(d: DigestSummaryDetectorInput): string {
  const sampled = d.sampleSummaries.length;
  const noun = d.findingCount === 1 ? "finding" : "findings";
  if (sampled === 0) {
    // Starved out of the sample budget (or empty payloads): keep the detector
    // visible with an explicit disclosure instead of silently dropping it.
    return `DETECTOR: ${d.name} — ${d.findingCount} ${noun} (no sample available)`;
  }
  const coverage =
    d.findingCount > sampled
      ? ` (summaries below are the latest ${sampled} of ${d.findingCount} findings)`
      : "";
  const lines = d.sampleSummaries.map((s) => `- ${s}`).join("\n");
  return `DETECTOR: ${d.name} — ${d.findingCount} ${noun}${coverage}\n${lines}`;
}

export function buildDigestSummaryPrompt(
  input: DigestSummaryInput,
): { systemPrompt: string; userText: string } | null {
  // Only bail when NO detector has sentences; detectors with findings but no
  // sampled sentences stay in with a "(no sample available)" line.
  if (!input.detectors.some((d) => d.sampleSummaries.length > 0)) return null;

  // Largest detectors carry the window's story; keep them when over budget.
  const ordered = [...input.detectors].sort((a, b) => b.findingCount - a.findingCount);
  const header = `PROJECT: ${input.projectName}\nWINDOW: ${formatWindowRange(input.windowStart, input.windowEnd)}\n\n`;

  const sections: string[] = [];
  let used = header.length;
  let omitted = 0;
  for (const d of ordered) {
    const section = detectorSection(d) + "\n\n";
    if (used + section.length > DIGEST_SUMMARY_MAX_PROMPT_CHARS) {
      omitted++;
      continue;
    }
    sections.push(section);
    used += section.length;
  }
  if (sections.length === 0) return null; // budget too tight for even one — nothing useful to say
  const tail = omitted > 0 ? `(+${omitted} more detectors omitted from this sample)\n` : "";
  return { systemPrompt: SYSTEM_PROMPT, userText: header + sections.join("") + tail };
}

export function buildDigestSummaryTool(): Tool {
  return {
    name: "submit_digest_summary",
    description:
      "Submit the alert summary. You MUST call this tool to complete. Do not respond with plain text.",
    parameters: Type.Object(
      {
        summary: Type.String({
          description:
            "2-4 plain sentences (~50-80 words) for an on-call engineer. First sentence must stand alone. No markdown.",
        }),
      },
      { additionalProperties: false, required: ["summary"] },
    ),
  };
}
