"use client";

import { useState } from "react";
import {
  DISMISS_REASONS,
  RESOLVE_REASONS,
  SIGNAL_NOTE_MAX_LENGTH,
  SIGNAL_STATUSES,
  type SignalStatus,
} from "@traceroot/core/signals";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSetSignalStatus } from "../hooks";

export const STATUS_LABELS: Record<SignalStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

const REASON_LABELS: Record<string, string> = {
  fixed_elsewhere: "Fixed outside TraceRoot",
  fixed_by_pr: "PR was merged",
  already_fixed_before: "Already fixed before this signal",
  unclear: "Signal is unclear",
  rca_wrong: "Analysis is incorrect",
  grouped_wrong: "Traces grouped incorrectly",
  expected_behavior: "Expected behavior",
  duplicate: "Duplicate signal",
  already_fixed: "Already fixed",
  low_impact: "Low impact",
  other: "Other",
};

const CLOSE_COPY = {
  resolved: {
    title: "Resolve signal",
    hint: "Save what fixed it. You can reopen it later.",
    notePlaceholder: "Link to the pull request or commit, or describe what fixed it.",
    submit: "Resolve",
    reasons: RESOLVE_REASONS,
  },
  dismissed: {
    title: "Dismiss signal",
    hint: "Save why this signal needs no action. You can reopen it later.",
    notePlaceholder: "What makes this signal incorrect or not worth acting on?",
    submit: "Dismiss & remember",
    reasons: DISMISS_REASONS,
  },
} as const;

/**
 * The signal's status as a dropdown. Reopening applies at once; resolving and
 * dismissing ask for a reason (and a note, required for "Other") first.
 */
export function SignalStatusControl({
  projectId,
  signalId,
  title,
  status,
}: {
  projectId: string;
  signalId: string;
  /** The signal's title, repeated in the dialog. */
  title: string;
  status: SignalStatus;
}) {
  const mutation = useSetSignalStatus(projectId, signalId);
  // The target status, and the status seen when the dialog opened: the save
  // sends the latter, so a change made meanwhile gets the server's conflict.
  const [closing, setClosing] = useState<{
    to: "resolved" | "dismissed";
    from: SignalStatus;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  const reset = () => {
    setClosing(null);
    setReason("");
    setNote("");
    mutation.reset();
  };

  const onPick = (next: string) => {
    if (next === status) return;
    mutation.reset();
    if (next === "open") {
      mutation.mutate({ change: { status: "open" }, expectedStatus: status });
    } else {
      setClosing({ to: next as "resolved" | "dismissed", from: status });
    }
  };

  const noteRequired = reason === "other";
  const canSubmit = !!reason && (!noteRequired || note.trim().length > 0) && !mutation.isPending;
  const copy = closing ? CLOSE_COPY[closing.to] : null;

  return (
    <>
      <Select value={status} onValueChange={onPick} disabled={mutation.isPending}>
        <SelectTrigger className="h-8 w-[160px] text-[13px]" aria-label="Signal status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SIGNAL_STATUSES.map((s) => (
            <SelectItem key={s} value={s} className="text-[13px]">
              {STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!closing && mutation.error && (
        <span className="ml-2 text-[11px] text-destructive">{mutation.error.message}</span>
      )}

      <Dialog open={!!closing} onOpenChange={(open) => !open && !mutation.isPending && reset()}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="text-[14px] font-semibold">{copy?.title}</DialogTitle>
            <DialogDescription className="space-y-1 text-[13px]">
              <span className="block text-foreground">{title}</span>
              <span className="block">{copy?.hint}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 space-y-4">
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">
                Reason <span className="font-normal text-muted-foreground">(required)</span>
              </p>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger className="h-9 text-[13px]" aria-label="Reason">
                  <SelectValue placeholder="Select a reason" />
                </SelectTrigger>
                <SelectContent>
                  {copy?.reasons.map((r) => (
                    <SelectItem key={r} value={r} className="text-[13px]">
                      {REASON_LABELS[r] ?? r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">
                Note{" "}
                <span className="font-normal text-muted-foreground">
                  {noteRequired ? "(required)" : "(optional)"}
                </span>
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={SIGNAL_NOTE_MAX_LENGTH}
                rows={3}
                placeholder={copy?.notePlaceholder}
                aria-label={closing?.to === "resolved" ? "Resolution note" : "Dismissal note"}
                className="resize-vertical w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
              />
              <p className="text-right text-[12px] tabular-nums text-muted-foreground">
                {note.length.toLocaleString()} / {SIGNAL_NOTE_MAX_LENGTH.toLocaleString()}
              </p>
            </div>
            {mutation.error && (
              <p className="text-[12px] text-destructive">{mutation.error.message}</p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={reset}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canSubmit}
                onClick={() =>
                  closing &&
                  mutation.mutate(
                    {
                      change: { status: closing.to, reason, note: note.trim() || null },
                      expectedStatus: closing.from,
                    },
                    { onSuccess: reset },
                  )
                }
              >
                {mutation.isPending ? "Saving..." : copy?.submit}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
