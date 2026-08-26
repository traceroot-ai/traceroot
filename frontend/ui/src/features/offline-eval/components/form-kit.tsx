"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/** One labelled field, matching the detector form's bordered card. */
export function FormCard({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border border-border", className)}>
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
        {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}
