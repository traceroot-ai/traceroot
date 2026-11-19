"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Native checkbox styled to the dense table language.
 *
 * `@radix-ui/react-checkbox` is not a dependency; the repo already uses raw
 * <input type="checkbox"> (ModelProvidersTab). Keeping it native also keeps
 * indeterminate state and label association free.
 */
export interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange"
> {
  onCheckedChange?: (checked: boolean) => void;
  /** Renders the mixed state used by "select all" header cells. */
  indeterminate?: boolean;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, onCheckedChange, indeterminate, ...props },
  forwardedRef,
) {
  const innerRef = React.useRef<HTMLInputElement>(null);

  React.useImperativeHandle(forwardedRef, () => innerRef.current as HTMLInputElement);

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = !!indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={innerRef}
      type="checkbox"
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      className={cn(
        "h-3.5 w-3.5 shrink-0 cursor-pointer rounded-sm border-border accent-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});
