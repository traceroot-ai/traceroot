"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * The shared dataset form — used by both the "New dataset" centered dialog and
 * the "Edit dataset" side panel, so create and edit stay identical (the way
 * Create Detector and the detector edit panel share fields).
 *
 * Schema toggles default off and are mostly illustrative for now: when enabled
 * they reveal an editable JSON block for the schema's properties/required. We
 * keep the shape visible so the concept is testable before the details are
 * settled.
 */

export interface DatasetFormState {
  name: string;
  description: string;
  metadata: string;
  inputSchemaEnabled: boolean;
  inputSchema: string;
  expectedSchemaEnabled: boolean;
  expectedSchema: string;
}

const DEFAULT_INPUT_SCHEMA = `{
  "type": "object",
  "properties": {
    "input": { "type": "string" }
  },
  "required": ["input"]
}`;

const DEFAULT_EXPECTED_SCHEMA = `{
  "type": "object",
  "properties": {
    "expected": { "type": "string" }
  },
  "required": ["expected"]
}`;

export function emptyDatasetForm(overrides: Partial<DatasetFormState> = {}): DatasetFormState {
  return {
    name: "",
    description: "",
    metadata: "",
    inputSchemaEnabled: false,
    inputSchema: DEFAULT_INPUT_SCHEMA,
    expectedSchemaEnabled: false,
    expectedSchema: DEFAULT_EXPECTED_SCHEMA,
    ...overrides,
  };
}

/** Bordered card matching the Create Detector form fields. */
function Card({
  label,
  optional,
  action,
  children,
}: {
  label: string;
  optional?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">
          {label}
          {optional && <span className="ml-1 font-normal text-muted-foreground/70">optional</span>}
        </span>
        {action}
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

const jsonBlockClass =
  "w-full resize-vertical border border-input bg-background px-3 py-2 font-mono text-[12px] leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring";

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
          placeholder="e.g. Billing routing"
          className="h-7 text-[13px]"
          required
        />
      </Card>

      <Card label="Description" optional>
        <textarea
          value={state.description}
          onChange={(e) => set("description", e.target.value)}
          rows={2}
          placeholder="What this collection of test cases is for"
          className="resize-vertical w-full border border-input bg-background px-3 py-2 text-[12px] leading-relaxed placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </Card>

      <Card label="Metadata" optional>
        <textarea
          value={state.metadata}
          onChange={(e) => set("metadata", e.target.value)}
          rows={2}
          placeholder={'{\n  "team": "support"\n}'}
          className={jsonBlockClass}
        />
      </Card>

      <SchemaCard
        label="Input schema"
        enabled={state.inputSchemaEnabled}
        onToggle={(v) => set("inputSchemaEnabled", v)}
        explanation="Describe the shape each test case's input must take. When on, rows are validated against this schema. Leave off to accept any input."
        value={state.inputSchema}
        onValueChange={(v) => set("inputSchema", v)}
      />

      <SchemaCard
        label="Expected output schema"
        enabled={state.expectedSchemaEnabled}
        onToggle={(v) => set("expectedSchemaEnabled", v)}
        explanation="Describe the shape of the expected answer. When on, expected values are validated against this schema. Leave off when a scorer judges the output directly."
        value={state.expectedSchema}
        onValueChange={(v) => set("expectedSchema", v)}
      />
    </div>
  );
}

function SchemaCard({
  label,
  enabled,
  onToggle,
  explanation,
  value,
  onValueChange,
}: {
  label: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  explanation: string;
  value: string;
  onValueChange: (v: string) => void;
}) {
  return (
    <Card label={label} action={<Switch checked={enabled} onCheckedChange={onToggle} />}>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{explanation}</p>
      {enabled && (
        <textarea
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          rows={7}
          spellCheck={false}
          className={cn(jsonBlockClass, "mt-2")}
          aria-label={`${label} JSON`}
        />
      )}
    </Card>
  );
}
