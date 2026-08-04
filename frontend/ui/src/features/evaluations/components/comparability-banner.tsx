/**
 * The single place the UI turns the comparison engine's `state` + `reasons` into
 * prose. Both the run-detail comparison strip and the compare page render THIS —
 * neither re-derives comparison semantics from `trustworthy`/`reasons` themselves
 * (see `deriveComparisonState` in `lib/eval/comparison.ts`, which owns that logic).
 *
 * A `trustworthy` comparison renders nothing here (the views show their authoritative
 * verdict). Every other state gets a banner: `exploratory` is a STRONG "not directly
 * comparable" warning so an exploratory delta is never mistaken for a ship / no-ship
 * result; `pending` is informational; `unavailable` is muted.
 */
import * as React from "react";
import { AlertTriangle, GitCompare, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ComparisonState, RunComparabilityReason } from "@/lib/eval/comparison";

/** Canonical reason → human text. Kept complete over every `RunComparabilityReason`
 *  so the banner never falls back to a raw enum token. */
export const COMPARABILITY_REASON_TEXT: Record<RunComparabilityReason, string> = {
  no_baseline: "No baseline was picked.",
  baseline_missing: "The baseline run couldn’t be found.",
  different_evaluation:
    "The runs are from different evaluations — no baseline relationship is saved.",
  different_dataset_version:
    "The runs used different dataset snapshots, so their cases don’t line up.",
  baseline_not_terminal: "The baseline run is still running.",
  candidate_not_terminal: "This run is still going.",
  case_set_mismatch: "The two runs covered different sets of cases.",
  main_scorer_incompatible: "The main scorer isn’t comparable between these runs.",
};

type Tone = "warn" | "info" | "muted";

const STATE_META: Record<
  Exclude<ComparisonState, "trustworthy">,
  { title: string; blurb: string; tone: Tone; Icon: typeof Info }
> = {
  exploratory: {
    title: "Exploratory comparison — not directly comparable",
    blurb: "Shown for exploration only. Don’t read these deltas as a ship / no-ship result.",
    tone: "warn",
    Icon: AlertTriangle,
  },
  pending: {
    title: "Comparison pending",
    blurb: "A run hasn’t finished, so the comparison isn’t final yet.",
    tone: "info",
    Icon: Info,
  },
  unavailable: {
    title: "No comparison",
    blurb: "There’s no baseline to compare this run against.",
    tone: "muted",
    Icon: GitCompare,
  },
};

const TONE_CLASS: Record<Tone, string> = {
  warn: "border-amber-400/60 bg-amber-100/50 text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200",
  info: "border-border bg-muted/40 text-foreground",
  muted: "border-border bg-muted/30 text-muted-foreground",
};

/**
 * Renders the comparability state; `null` for a trustworthy comparison. `action`
 * (e.g. a "Clear" button) is placed at the trailing edge.
 */
export function ComparabilityBanner({
  state,
  reasons,
  className,
  action,
}: {
  state: ComparisonState;
  reasons: readonly RunComparabilityReason[];
  className?: string;
  action?: React.ReactNode;
}): React.ReactElement | null {
  if (state === "trustworthy") return null;
  const meta = STATE_META[state];
  // Defensive: an unrecognized/absent discriminant degrades to nothing rather than
  // crashing the run-detail surface. The backend always sends one of the four states.
  if (!meta) return null;
  const { Icon } = meta;
  const lines = reasons.map((r) => COMPARABILITY_REASON_TEXT[r] ?? r);
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded border px-3 py-2 text-[11px]",
        TONE_CLASS[meta.tone],
        className,
      )}
      role={meta.tone === "warn" ? "alert" : undefined}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{meta.title}</div>
        <div className="mt-0.5 opacity-90">{meta.blurb}</div>
        {lines.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
