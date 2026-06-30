import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface LoadingStateProps {
  /** Text shown next to the spinner. */
  label: string;
  className?: string;
}

/**
 * Inline spinner + label for loading states. Drop it inside an existing centered
 * wrapper so loading feedback is consistent (an animated spinner, not bare text)
 * across pages.
 */
export function LoadingState({ label, className }: LoadingStateProps) {
  return (
    <div
      role="status"
      className={cn("flex items-center gap-2 text-[13px] text-muted-foreground", className)}
    >
      <Loader2 className="h-4 w-4 animate-spin" />
      {label}
    </div>
  );
}
