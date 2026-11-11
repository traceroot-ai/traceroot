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
      <div className="flex h-9 items-center justify-between border-b border-border px-4">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}
