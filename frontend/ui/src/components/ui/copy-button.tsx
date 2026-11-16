"use client";

import * as React from "react";
import { Copy, Check } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";
import { cn } from "@/lib/utils";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick"> {
  value: string;
  onCopy?: () => void;
  iconClassName?: string;
}

/**
 * Copy button that shows a check icon after copying
 */
const CopyButton = React.forwardRef<HTMLButtonElement, CopyButtonProps>(
  ({ value, onCopy, className, iconClassName, variant = "ghost", size = "sm", ...props }, ref) => {
    const [copied, setCopied] = React.useState(false);
    const [copyError, setCopyError] = React.useState(false);
    const errorId = React.useId();
    const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(
      () => () => {
        if (resetTimer.current) clearTimeout(resetTimer.current);
      },
      [],
    );

    const handleCopy = async () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
      setCopied(false);
      setCopyError(false);
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        setCopyError(true);
        return;
      }
      setCopied(true);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
      onCopy?.();
    };

    return (
      <Popover open={copyError} onOpenChange={setCopyError}>
        <PopoverAnchor asChild>
          <Button
            ref={ref}
            variant={variant}
            size={size}
            className={cn("h-7 w-7 p-0", className)}
            onClick={handleCopy}
            {...props}
            aria-describedby={
              copyError
                ? [props["aria-describedby"], errorId].filter(Boolean).join(" ")
                : props["aria-describedby"]
            }
          >
            {copied ? (
              <Check className={cn("h-3.5 w-3.5 text-success", iconClassName)} />
            ) : (
              <Copy className={cn("h-3.5 w-3.5", iconClassName)} />
            )}
          </Button>
        </PopoverAnchor>
        <PopoverContent
          id={errorId}
          role="alert"
          className="w-auto max-w-[calc(100vw-2rem)] px-3 py-2 text-xs"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          Could not copy to clipboard. Try again.
        </PopoverContent>
      </Popover>
    );
  },
);
CopyButton.displayName = "CopyButton";

export { CopyButton };
