'use client';

import * as React from "react";
import { Copy, Check } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick'> {
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

    const handleCopy = async () => {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      onCopy?.();
      setTimeout(() => setCopied(false), 2000);
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
        {copied ? (
          <Check className={cn("h-3.5 w-3.5 text-green-600", iconClassName)} />
        ) : (
          <Copy className={cn("h-3.5 w-3.5", iconClassName)} />
        )}
      </Button>
    );
  }
);
CopyButton.displayName = "CopyButton";

export { CopyButton };
