import type { SignalStatus } from "@traceroot/core/signals";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS } from "./signal-status-control";

const VARIANTS = {
  open: "warning",
  resolved: "success",
  dismissed: "default",
} as const satisfies Record<SignalStatus, "warning" | "success" | "default">;

/** A signal's state at a glance: open needs attention, resolved is done, dismissed is quiet. */
export function SignalStatusBadge({ status }: { status: SignalStatus }) {
  return (
    <Badge variant={VARIANTS[status]} data-status={status}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {STATUS_LABELS[status]}
    </Badge>
  );
}
