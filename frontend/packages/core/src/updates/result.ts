import { z } from "zod";

/**
 * The one structured result an update run produces. Slack, email and the UI
 * all render from it, so the numbers in each are the same by construction.
 */

export const evidenceLinkSchema = z.object({
  kind: z.enum(["trace", "signal", "dashboard", "pull_request", "release", "page"]),
  label: z.string().min(1).max(120),
  url: z.string().url(),
});

export const resultItemSchema = z.object({
  /** Id of the computed finding this item narrates, when it narrates one. */
  findingId: z.string().max(200).optional(),
  text: z.string().min(1).max(600),
  /** An item with nothing to open is left out, so at least one link is required. */
  evidence: z.array(evidenceLinkSchema).min(1).max(6),
});

export const resultSectionSchema = z.object({
  id: z.enum(["overview", "shifts", "signals", "code_changes", "alerts", "evals", "cost", "other"]),
  title: z.string().min(1).max(80),
  items: z.array(resultItemSchema).max(12),
});

const resultObject = z.object({
  nothingToReport: z.boolean(),
  /** One sentence, written first; it is the Slack message and the email subject. */
  headline: z.string().min(1).max(200),
  summary: z.string().max(1200),
  sections: z.array(resultSectionSchema).max(8),
  suggestedDetectors: z
    .array(z.object({ name: z.string().min(1).max(80), checks: z.string().min(1).max(300) }))
    .max(3),
  /** Short text kept for the next run: baselines and known-noisy items. */
  notesForNextRun: z.string().max(1500),
});

/** A result with nothing to report has no sections; one with something has at least one. */
export const updateResultSchema = resultObject.superRefine((result, ctx) => {
  const hasItems = result.sections.some((section) => section.items.length > 0);
  if (result.nothingToReport && result.sections.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["sections"],
      message: "nothingToReport means no sections",
    });
  }
  if (!result.nothingToReport && !hasItems) {
    ctx.addIssue({
      code: "custom",
      path: ["sections"],
      message: "a report needs at least one item",
    });
  }
});

export type EvidenceLink = z.infer<typeof evidenceLinkSchema>;
export type UpdateResult = z.infer<typeof updateResultSchema>;
