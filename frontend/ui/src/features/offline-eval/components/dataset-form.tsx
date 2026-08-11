"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The shared dataset form — used by both the "New dataset" and "Edit dataset"
 * panels, so create and edit stay identical.
 *
 * v1 is deliberately just Name + Description. Per-row input / expected-output
 * JSON-schema validation is a later addition — it's off by default and nothing
 * depends on it yet, so it can land without touching existing datasets.
 */

export interface DatasetFormState {
  name: string;
  description: string;
}

export function emptyDatasetForm(overrides: Partial<DatasetFormState> = {}): DatasetFormState {
  return { name: "", description: "", ...overrides };
}

/** Bordered card matching the Create Detector form fields. */
function Card({
  label,
  optional,
  children,
}: {
  label: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">
          {label}
          {optional && (
            <span className="ml-1 font-normal text-muted-foreground/70">(optional)</span>
          )}
        </span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

export function DatasetFormFields({
  state,
  onChange,
  className,
}: {
  state: DatasetFormState;
  onChange: (next: DatasetFormState) => void;
  className?: string;
}) {
  const set = <K extends keyof DatasetFormState>(key: K, value: DatasetFormState[K]) =>
    onChange({ ...state, [key]: value });

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <Card label="Name">
        <Input
          value={state.name}
          onChange={(e) => set("name", e.target.value)}
          aria-label="Name"
          className="h-7 text-[13px]"
          required
        />
      </Card>

      <Card label="Description" optional>
        <Input
          value={state.description}
          onChange={(e) => set("description", e.target.value)}
          aria-label="Description"
          className="h-7 text-[13px]"
        />
      </Card>
    </div>
  );
}
