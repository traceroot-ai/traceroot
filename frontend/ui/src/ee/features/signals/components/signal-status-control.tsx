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
import { useT } from "@/lib/i18n/provider";
import type { MessageKey } from "@/lib/i18n/messages/en";

export const STATUS_LABELS: Record<SignalStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

/** The same labels as message keys, for showing a status in the visitor's language. */
export const STATUS_LABEL_KEYS: Record<SignalStatus, MessageKey> = {
  open: "eeSignalStatus.open",
  resolved: "eeSignalStatus.resolved",
  dismissed: "eeSignalStatus.dismissed",
};

// The text of each reason and of the two dialogs is in the `eeSignalStatus` message group.
const REASON_LABELS: Record<string, MessageKey> = {
  fixed_elsewhere: "eeSignalStatus.reasonFixedElsewhere",
  fixed_by_pr: "eeSignalStatus.reasonFixedByPr",
  already_fixed_before: "eeSignalStatus.reasonAlreadyFixedBefore",
  unclear: "eeSignalStatus.reasonUnclear",
  rca_wrong: "eeSignalStatus.reasonRcaWrong",
  grouped_wrong: "eeSignalStatus.reasonGroupedWrong",
  expected_behavior: "eeSignalStatus.reasonExpectedBehavior",
  duplicate: "eeSignalStatus.reasonDuplicate",
  already_fixed: "eeSignalStatus.reasonAlreadyFixed",
  low_impact: "eeSignalStatus.reasonLowImpact",
  other: "eeSignalStatus.reasonOther",
};

const CLOSE_COPY = {
  resolved: {
    title: "eeSignalStatus.resolveTitle",
    hint: "eeSignalStatus.resolveHint",
    notePlaceholder: "eeSignalStatus.resolvePlaceholder",
    submit: "eeSignalStatus.resolveSubmit",
    reasons: RESOLVE_REASONS,
  },
  dismissed: {
    title: "eeSignalStatus.dismissTitle",
    hint: "eeSignalStatus.dismissHint",
    notePlaceholder: "eeSignalStatus.dismissPlaceholder",
    submit: "eeSignalStatus.dismissSubmit",
    reasons: DISMISS_REASONS,
  },
} as const satisfies Record<string, Record<string, MessageKey | readonly string[]>>;

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
  const t = useT();
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
        <SelectTrigger
          className="h-8 w-[160px] text-[13px]"
          aria-label={t("eeSignalStatus.statusAria")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SIGNAL_STATUSES.map((s) => (
            <SelectItem key={s} value={s} className="text-[13px]">
              {t(STATUS_LABEL_KEYS[s])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!closing && mutation.error && (
        <span className="ml-2 text-[12px] text-destructive">{mutation.error.message}</span>
      )}

      <Dialog open={!!closing} onOpenChange={(open) => !open && !mutation.isPending && reset()}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle>{copy && t(copy.title)}</DialogTitle>
            <DialogDescription className="space-y-1 text-[13px]">
              <span className="block text-foreground">{title}</span>
              <span className="block">{copy && t(copy.hint)}</span>
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 space-y-4">
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">
                {t("eeSignalStatus.reason")}{" "}
                <span className="font-normal text-muted-foreground">
                  {t("eeSignalStatus.required")}
                </span>
              </p>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger aria-label={t("eeSignalStatus.reason")}>
                  <SelectValue placeholder={t("eeSignalStatus.selectReason")} />
                </SelectTrigger>
                <SelectContent>
                  {copy?.reasons.map((r) => (
                    <SelectItem key={r} value={r} className="text-[13px]">
                      {REASON_LABELS[r] ? t(REASON_LABELS[r]) : r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <p className="text-[13px] font-medium">
                {t("eeSignalStatus.note")}{" "}
                <span className="font-normal text-muted-foreground">
                  {noteRequired ? t("eeSignalStatus.required") : t("eeSignalStatus.optional")}
                </span>
              </p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={SIGNAL_NOTE_MAX_LENGTH}
                rows={3}
                placeholder={copy ? t(copy.notePlaceholder) : undefined}
                aria-label={
                  closing?.to === "resolved"
                    ? t("eeSignalStatus.resolutionNote")
                    : t("eeSignalStatus.dismissalNote")
                }
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
                {t("common.cancel")}
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
                {mutation.isPending ? t("common.saving") : copy && t(copy.submit)}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
