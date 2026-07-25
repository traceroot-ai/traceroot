"use client";

import { useState, useEffect, useRef, useCallback } from "react";
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
  nullable?: boolean;
  options?: { label: string; value: string }[];
}

const FIELD_DEFS: FieldDef[] = [
  {
    field: "environment",
    label: "Environment",
    ops: ["=", "!="],
    valueType: "text",
    nullable: true,
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
  emptyMessage?: string;
}

export function TriggerEditor({
  conditions: initialConditions,
  onChange,
  onSave,
  isSaving,
  readOnly,
  asCard,
  emptyMessage = "Runs on all completed traces.",
}: TriggerEditorProps) {
  const nextConditionKeyRef = useRef(0);
  const createConditionKey = useCallback(() => `condition-${nextConditionKeyRef.current++}`, []);
  const [conditions, setConditions] = useState<TriggerCondition[]>(initialConditions);
  const [dirty, setDirty] = useState(false);
  const [conditionKeys, setConditionKeys] = useState<string[]>(() =>
    initialConditions.map(() => createConditionKey()),
  );
  const previousNonNullValuesRef = useRef<Record<string, string>>({});
  const lastEmittedConditionsRef = useRef<TriggerCondition[] | null>(null);

  useEffect(() => {
    setConditions(initialConditions);
    if (lastEmittedConditionsRef.current === initialConditions) {
      setConditionKeys((currentKeys) => {
        const nextKeys = initialConditions.map(
          (_, index) => currentKeys[index] ?? createConditionKey(),
        );
        const liveKeys = new Set(nextKeys);
        for (const key of Object.keys(previousNonNullValuesRef.current)) {
          if (!liveKeys.has(key)) {
            delete previousNonNullValuesRef.current[key];
          }
        }
        return nextKeys;
      });
    } else {
      previousNonNullValuesRef.current = {};
      setConditionKeys(initialConditions.map(() => createConditionKey()));
    }
    lastEmittedConditionsRef.current = null;
    setDirty(false);
  }, [createConditionKey, initialConditions]);

  const update = (next: TriggerCondition[]) => {
    lastEmittedConditionsRef.current = next;
    setConditions(next);
    if (onChange) {
      onChange(next);
    } else {
      setDirty(true);
    }
  };

  const addCondition = () => {
    const first = FIELD_DEFS[0];
    setConditionKeys([...conditionKeys, createConditionKey()]);
    update([
      ...conditions,
      { field: first.field, op: first.ops[0], value: defaultValueForField(first.field) },
    ]);
  };

  const removeCondition = (i: number) => {
    const removedKey = conditionKeys[i];
    if (removedKey) {
      delete previousNonNullValuesRef.current[removedKey];
    }
    setConditionKeys(conditionKeys.filter((_, idx) => idx !== i));
    update(conditions.filter((_, idx) => idx !== i));
  };

  const updateCondition = (i: number, patch: Partial<TriggerCondition>) => {
    const rowKey = conditionKeys[i];
    update(
      conditions.map((c, idx) => {
        if (idx !== i) return c;
        const merged = { ...c, ...patch };
        if (patch.field && patch.field !== c.field) {
          const def = FIELD_DEFS.find((d) => d.field === patch.field);
          merged.op = def?.ops[0] ?? "=";
          merged.value = defaultValueForField(patch.field);
          if (rowKey) {
            delete previousNonNullValuesRef.current[rowKey];
          }
        }
        return merged;
      }),
    );
  };

  const setNullValue = (i: number, cond: TriggerCondition, checked: boolean) => {
    const rowKey = conditionKeys[i];
    if (checked) {
      if (rowKey) {
        previousNonNullValuesRef.current[rowKey] = String(cond.value ?? "");
      }
      updateCondition(i, { value: null });
      return;
    }
    updateCondition(i, { value: rowKey ? (previousNonNullValuesRef.current[rowKey] ?? "") : "" });
  };

  const conditionRows = (
    <div className={`space-y-1.5 ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
      {conditions.map((cond, i) => {
        const fieldDef = FIELD_DEFS.find((d) => d.field === cond.field) ?? FIELD_DEFS[0];
        return (
          <div key={conditionKeys[i] ?? i} className="flex items-center gap-1.5">
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
              <div className="flex flex-1 items-center gap-2">
                <Input
                  value={cond.value === null ? "" : String(cond.value ?? "")}
                  onChange={(e) => {
                    const rowKey = conditionKeys[i];
                    if (rowKey) {
                      previousNonNullValuesRef.current[rowKey] = e.target.value;
                    }
                    updateCondition(i, { value: e.target.value });
                  }}
                  placeholder="Enter value..."
                  disabled={cond.value === null}
                  className="h-7 flex-1 text-[12px]"
                />
                {fieldDef.nullable && (
                  <label className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={cond.value === null}
                      onChange={(e) => setNullValue(i, cond, e.target.checked)}
                      className="h-3 w-3"
                    />
                    Value is null
                  </label>
                )}
              </div>
            )}

            {/* Remove — hidden in readOnly */}
            {!readOnly && (
              <button
                type="button"
                aria-label="Remove condition"
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
            <p className="text-[12px] text-muted-foreground">{emptyMessage}</p>
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
        <p className="text-[12px] text-muted-foreground">{emptyMessage}</p>
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
