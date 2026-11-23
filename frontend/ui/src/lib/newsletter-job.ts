/**
 * The scheduled tick's newsletter task: adds people to the newsletter segment
 * 14 days after they sign up (@traceroot/core/email's runNewsletterAudience).
 * Cloud only, and off unless NEWSLETTER_SEGMENT_ENABLED is "true"; with
 * NEWSLETTER_SEGMENT_DRY_RUN "true" it reads and counts but writes nothing.
 * The follow-up switches do not apply: the newsletter is not a follow-up.
 */
import { prisma } from "@traceroot/core";
import { runNewsletterAudience, type AudienceRun } from "@traceroot/core/email";
import { isCloud } from "@/lib/server/cloud";

/** People per tick; the provider allows a few calls a second, and the rest wait 15 minutes. */
const PER_TICK = 25;

export type NewsletterMode = "off" | "dry_run" | "apply";

export function newsletterMode(
  environment: Record<string, string | undefined> = process.env,
): NewsletterMode {
  const on = (name: string) => environment[name]?.trim().toLowerCase() === "true";
  if (on("NEWSLETTER_SEGMENT_DRY_RUN")) return "dry_run";
  return on("NEWSLETTER_SEGMENT_ENABLED") ? "apply" : "off";
}

export async function runNewsletterJob(
  options: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<AudienceRun | { mode: "off" }> {
  const mode = newsletterMode();
  if (mode === "off" || !isCloud()) return { mode: "off" };
  return runNewsletterAudience(prisma, {
    mode: { kind: "scheduled", now: options.now ?? new Date() },
    apply: mode === "apply",
    limit: PER_TICK,
    fetchImpl: options.fetchImpl,
  });
}
