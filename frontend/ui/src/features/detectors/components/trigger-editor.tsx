"use client";

import { useState, useEffect } from "react";
import { X, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

export interface TriggerCondition {
  field: string;
  op: string;
  value: unknown;
}

interface FieldDef {
  field: string;
  label: string;
  ops: string[];
  valueType: "text" | "select";
  options?: { label: string; value: string }[];
}

const FIELD_DEFS: FieldDef[] = [
  {
    field: "environment",
    label: "Environment",
    ops: ["=", "!="],
    valueType: "text",
  },
  {
    field: "status",
    label: "Status",
    ops: ["="],
    valueType: "select",
    options: [
      { label: "Error", value: "ERROR" },
      { label: "Success", value: "OK" },
    ],
  },
];

const defaultValueForField = (field: string): unknown => {
  const def = FIELD_DEFS.find((d) => d.field === field);
  if (!def) return "";
  if (def.valueType === "select") return def.options?.[0]?.value ?? "";
  return "";
};

interface TriggerEditorProps {
  conditions: TriggerCondition[];
  /** Controlled mode: called on every change, no Save button shown */
  onChange?: (conditions: TriggerCondition[]) => void;
  /** Uncontrolled/save mode: shows a Save button when dirty */
  onSave?: (conditions: TriggerCondition[]) => void;
  isSaving?: boolean;
  /** Read-only: show conditions but hide add/remove/save controls */
  readOnly?: boolean;
  /** Card mode: renders as a bordered card section (header + body) for embedding inside a card container */
  asCard?: boolean;
}

export function TriggerEditor({
  conditions: initialConditions,
  onChange,
  onSave,
  isSaving,
  readOnly,
  asCard,
}: TriggerEditorProps) {
  const [conditions, setConditions] = useState<TriggerCondition[]>(initialConditions);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setConditions(initialConditions);
    setDirty(false);
  }, [initialConditions]);

  const update = (next: TriggerCondition[]) => {
    setConditions(next);
    if (onChange) {
      onChange(next);
    } else {
      setDirty(true);
    }
  };

  const addCondition = () => {
    const first = FIELD_DEFS[0];
    update([
      ...conditions,
      { field: first.field, op: first.ops[0], value: defaultValueForField(first.field) },
    ]);
  };

  const removeCondition = (i: number) => {
    update(conditions.filter((_, idx) => idx !== i));
  };

  const updateCondition = (i: number, patch: Partial<TriggerCondition>) => {
    update(
      conditions.map((c, idx) => {
        if (idx !== i) return c;
        const merged = { ...c, ...patch };
        if (patch.field && patch.field !== c.field) {
          const def = FIELD_DEFS.find((d) => d.field === patch.field);
          merged.op = def?.ops[0] ?? "=";
          merged.value = defaultValueForField(patch.field);
        }
        return merged;
      }),
    );
  };

  const conditionRows = (
    <div className={`space-y-1.5 ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
      {conditions.map((cond, i) => {
        const fieldDef = FIELD_DEFS.find((d) => d.field === cond.field) ?? FIELD_DEFS[0];
        return (
          <div key={i} className="flex items-center gap-1.5">
            {/* Field */}
            <Select value={cond.field} onValueChange={(val) => updateCondition(i, { field: val })}>
              <SelectTrigger className="h-7 w-[120px] shrink-0 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_DEFS.map((d) => (
                  <SelectItem key={d.field} value={d.field} className="text-[12px]">
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Op */}
            <Select value={cond.op} onValueChange={(val) => updateCondition(i, { op: val })}>
              <SelectTrigger className="h-7 w-14 shrink-0 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fieldDef.ops.map((op) => (
                  <SelectItem key={op} value={op} className="text-[12px]">
                    {op}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Value */}
            {fieldDef.valueType === "select" ? (
              <Select
                value={cond.value as string}
                onValueChange={(val) => updateCondition(i, { value: val })}
              >
                <SelectTrigger className="h-7 flex-1 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fieldDef.options?.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value} className="text-[12px]">
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={cond.value as string}
                onChange={(e) => updateCondition(i, { value: e.target.value })}
                placeholder="Enter value..."
                className="h-7 flex-1 text-[12px]"
              />
            )}

            {/* Remove — hidden in readOnly */}
            {!readOnly && (
              <button
                type="button"
                onClick={() => removeCondition(i)}
                className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  if (asCard) {
    return (
      <>
        {/* Card header */}
        <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
          <span className="text-[12px] font-medium text-muted-foreground">Filter</span>
          {!readOnly && (
            <button
              type="button"
              onClick={addCondition}
              className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              Add condition
            </button>
          )}
        </div>
        {/* Card body */}
        <div className="p-3">
          {conditions.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">Runs on all completed traces.</p>
          ) : (
            <>
              <p className="mb-2 text-[12px] text-muted-foreground">All conditions must match.</p>
              {conditionRows}
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div>
      {/* Header row */}
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[12px] font-medium text-muted-foreground">Filter</p>
        {!readOnly && (
          <button
            type="button"
            onClick={addCondition}
            className="flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
            Add condition
          </button>
        )}
      </div>

      {conditions.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">Runs on all completed traces.</p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-muted-foreground">All conditions must match.</p>
          {conditionRows}
        </>
      )}

      {/* Save button — only in uncontrolled/save mode when dirty and not readOnly */}
      {!readOnly && !onChange && dirty && onSave && (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            className="h-7 text-[12px]"
            onClick={() => onSave(conditions)}
            disabled={isSaving}
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}
