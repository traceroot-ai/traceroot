import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Dense, low-chroma badges to match the existing table/chip language
// (text-[11px], bg-muted/50 headers). Status hues stay muted on purpose:
// the workbench uses color to mean something, not to decorate.
const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none",
  {
    variants: {
      variant: {
        default: "border-border bg-muted/60 text-muted-foreground",
        outline: "border-border bg-transparent text-muted-foreground",
        foreground: "border-border bg-muted text-foreground",
        // Semantic: tokens from globals.css, each pair checked for AA contrast.
        success: "border-success-border bg-success-soft text-success",
        warning: "border-warning-border bg-warning-soft text-warning",
        danger: "border-danger-border bg-danger-soft text-danger",
        info: "border-info-border bg-info-soft text-info",
        accent: "border-brand-border bg-brand-soft text-brand",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
