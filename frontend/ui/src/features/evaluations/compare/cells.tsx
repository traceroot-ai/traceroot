"use client";

import { changeSentiment, SENTIMENT_CLASS } from "@/features/offline-eval/utils";
import type { ScorerDirection } from "@/lib/eval/comparison";
import { cn } from "@/lib/utils";

/** One coloured dot for a run, named for assistive tech and on hover so colour isn't the
 *  only way to tell the runs apart. */
export function Dot({ color }: { color: string }) {
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", color)} aria-hidden />;
}

/** The run a value belongs to: its label for screen readers, and on hover. */
export function RunLabel({ label }: { label: string }) {
  return <span className="sr-only select-none">{label}: </span>;
}

/** A signed, direction-aware delta vs the baseline (green = better, red = worse; a metric
 *  with no direction is never coloured). */
export function Delta({
  value,
  text,
  direction,
}: {
  value: number;
  /** The change as shown, sign included. */
  text: string;
  direction: ScorerDirection;
}) {
  // A change that rounds to nothing is shown unsigned; drop it rather than print "0ms".
  if (value === 0 || !/^[+−]/.test(text)) return null;
  const sentiment =
    direction !== "none" ? changeSentiment(value, direction === "higher_is_better") : "neutral";
  return <span className={cn("ml-1", SENTIMENT_CLASS[sentiment])}>{text}</span>;
}
