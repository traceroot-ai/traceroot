"use client";

import { cn } from "@/lib/utils";
import type { AlertTone } from "./alert-display";

const TONE_STYLES: Record<AlertTone, string> = {
  ok: "bg-success-soft text-success",
  alert: "bg-danger-soft text-danger",
  warning: "bg-warning-soft text-warning",
  neutral: "bg-muted text-muted-foreground",
};

const PILL =
  "inline-flex min-w-[3.5rem] items-center justify-center rounded-[2px] border border-transparent px-1.5 py-0.5 text-[12px] font-medium";

type ToneProps = { tone: AlertTone };

/** A status pill in one of the four alert tones; the Alerts and Loops lists share it. */
export function TonePill({ tone, className, ...props }: ToneProps & React.ComponentProps<"span">) {
  return <span className={cn(PILL, TONE_STYLES[tone], className)} {...props} />;
}

/** The same pill as a button, for one that opens a popover with its reason. */
export function TonePillButton({
  tone,
  className,
  ...props
}: ToneProps & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(
        PILL,
        TONE_STYLES[tone],
        className,
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
      {...props}
    />
  );
}
