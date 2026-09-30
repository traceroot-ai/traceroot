/**
 * Prompts for assignment, criteria writing and criteria checking. Wording is the
 * benchmark's, with the trace-fact and corpus-specific phrases removed; the
 * corpus validation run checks this exact text.
 */

import type { Candidate } from "./types.js";

export const ASSIGN_SYSTEM = `You assign a flagged agent trace ("hit") to a tracked signal, or decide it is a new signal.

A signal is one recurring defect: a set of hits that ONE code change would remove. Two hits belong to the same signal when the same fix would remove both, even if they involve different tools, places or wording. Two hits are different signals when they need different fixes, even if their text looks similar.

You receive the hit (the detector's output for one trace) and candidate signals, each with its title, membership criteria (covers / does not cover), one example hit, status and count.
Pick the single candidate whose criteria cover this hit, or "none" if no candidate's criteria cover it. Do not stretch criteria: if the hit would need the criteria to be widened, answer "none" and describe the new signal.
When you answer "none", write the new signal: a short title, "covers" and "excludes". Aim for the granularity of one code change.

Rules for the title and criteria:
- Describe the defect and its mechanism (what the agent or tool did wrong), never the user's request.
- Never include specific values: city or place names, dates, ids, amounts, currencies, user names, model names, quoted messages. Say "the requested city", "the tool", "the constraint" instead.
- "covers" must match any future hit with the same defect regardless of which request, place or tool instance it happened on.
- "excludes" names nearby defects that need a different fix.`;

export const WRITER_SYSTEM = `${ASSIGN_SYSTEM}

You are only writing the new signal now: the assigner already decided that no candidate covers this hit.`;

export const VALIDATE_SYSTEM =
  "You check whether membership criteria cover a hit. Be literal: covered only if the hit clearly matches 'covers' and is not in 'excludes'.";

export function candidatesText(candidates: readonly Candidate[]): string {
  if (candidates.length === 0) return "(no candidates: this partition has no signals yet)";
  return candidates
    .map(
      (c) =>
        `[${c.label}] ${c.title} (status=${c.status}, hits=${c.hitCount})\n` +
        `  covers: ${c.covers}\n  excludes: ${c.excludes}\n  example: ${c.example.slice(0, 600)}`,
    )
    .join("\n\n");
}

export function assignUserText(material: string, candidates: readonly Candidate[]): string {
  return `HIT:\n${material}\n\nCANDIDATE SIGNALS:\n${candidatesText(candidates)}\n\nAnswer with the candidate id or 'none'.`;
}

export function writerUserText(material: string, candidates: readonly Candidate[]): string {
  return `HIT:\n${material}\n\nEXISTING NEARBY SIGNALS (none of them covers the hit):\n${candidatesText(candidates)}\n\nWrite the new signal.`;
}

export function validateUserText(
  covers: string,
  excludes: string,
  texts: readonly string[],
): string {
  return (
    `Membership criteria of a signal:\ncovers: ${covers}\nexcludes: ${excludes}\n\n` +
    "For each hit below, answer whether the criteria cover it (true/false), in order.\n\n" +
    texts.map((t, i) => `HIT ${i}:\n${t}`).join("\n\n")
  );
}

/** Jev Choice question over the shortlist plus "none". */
export function jevAssignQuestion(candidates: readonly Candidate[]) {
  const criteria: Record<string, { what: string; not_for: string }> = {};
  for (const c of candidates) {
    criteria[c.label] = {
      what: `${c.title}. Covers: ${c.covers} Example hit: ${c.example.slice(0, 400)}`,
      not_for: c.excludes,
    };
  }
  criteria.none = {
    what: "No candidate signal's criteria cover the hit; the same code change would not remove it together with any candidate's hits. It is a new signal.",
    not_for: "Hits that a candidate's criteria cover.",
  };
  return {
    signal: {
      type: "choice" as const,
      instructions: {
        question:
          "Which candidate signal's membership criteria cover `hit`? Pick the signal whose criteria describe the same defect, i.e. one code change would remove both. Answer none if no candidate covers it.",
      },
      criteria,
    },
  };
}

/** One Jev yes/no question per text: do the criteria cover it? */
export function jevValidateQuestions(count: number) {
  const questions: Record<
    string,
    { type: "noul"; instructions: { question: string }; criteria: { true: string; false: string } }
  > = {};
  for (let i = 0; i < count; i++) {
    questions[`hit_${i}`] = {
      type: "noul",
      instructions: { question: `Do the membership \`criteria\` cover \`hit_${i}\`?` },
      criteria: {
        true: "The hit clearly matches what the criteria cover and is not something the criteria exclude.",
        false:
          "The hit does not match what the criteria cover, or it is something the criteria exclude.",
      },
    };
  }
  return questions;
}
