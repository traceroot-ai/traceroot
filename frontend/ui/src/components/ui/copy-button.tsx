"use client";

import * as React from "react";
import { Copy, Check, X } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick"> {
  value: string;
  onCopy?: () => void;
  iconClassName?: string;
}

type CopyStatus = "idle" | "copied" | "failed";
const STATUS_RESET_DELAY_MS = 2000;

/**
 * Copy button that shows a check icon after copying, or a failed icon if the
 * clipboard write was rejected (denied permission, insecure context, etc.).
 */
const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ value, onCopy, className, iconClassName, variant = "ghost", size = "sm", ...props }, ref) => {
    const [status, setStatus] = React.useState<CopyStatus>("idle");
    const resetTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Clear any pending reset on unmount so it never fires setState after
    // the button is gone.
    React.useEffect(() => {
      return () => {
        if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
      };
    }, []);

    const scheduleReset = () => {
      // A prior click's reset must not fire mid-way through this one — e.g.
      // copy, fail, copy again inside 2s would otherwise let the first
      // timeout revert the second click's "copied" state early.
      if (resetTimeoutRef.current) clearTimeout(resetTimeoutRef.current);
      resetTimeoutRef.current = setTimeout(() => setStatus("idle"), STATUS_RESET_DELAY_MS);
    };

    const handleCopy = async () => {
      try {
        await navigator.clipboard.writeText(value);
        setStatus("copied");
        onCopy?.();
        scheduleReset();
      } catch (err) {
        // A rejected write must not become an unhandled promise rejection,
        // and must not be mistaken for success — surface it as its own icon
        // state instead of silently leaving the idle Copy icon.
        console.error("Failed to copy to clipboard:", err);
        setStatus("failed");
        scheduleReset();
      }
    };

    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        className={cn("h-7 w-7 p-0", className)}
        onClick={handleCopy}
        {...props}
      >
        {status === "copied" ? (
          <Check className={cn("h-3.5 w-3.5 text-green-600", iconClassName)} />
        ) : status === "failed" ? (
          <X className={cn("h-3.5 w-3.5 text-destructive", iconClassName)} />
        ) : (
          <Copy className={cn("h-3.5 w-3.5", iconClassName)} />
        )}
      </Button>
    );
  },
);
CopyButton.displayName = "CopyButton";

export { CopyButton };
