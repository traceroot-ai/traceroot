"use client";

import * as React from "react";
import { Copy, Check } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { Popover, PopoverAnchor, PopoverContent } from "./popover";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

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
    const t = useT();
    const [copied, setCopied] = React.useState(false);
    const [copyError, setCopyError] = React.useState(false);
    const errorId = React.useId();
    const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const copyAttempt = React.useRef(0);

    React.useEffect(
      () => () => {
        copyAttempt.current += 1;
        if (resetTimer.current) clearTimeout(resetTimer.current);
      },
      [],
    );

    const handleCopy = async () => {
      const attempt = ++copyAttempt.current;
      if (resetTimer.current) clearTimeout(resetTimer.current);
      setCopied(false);
      setCopyError(false);
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        if (attempt === copyAttempt.current) setCopyError(true);
        return;
      }
      if (attempt !== copyAttempt.current) return;
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
            aria-label={props["aria-label"] ?? props.title ?? t("componentsUi.copy")}
            title={props.title ?? props["aria-label"] ?? t("componentsUi.copy")}
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
          {t("componentsUi.copyFailed")}
        </PopoverContent>
      </Popover>
    );
  },
);
CopyButton.displayName = "CopyButton";

export { CopyButton };
