"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { X, Plus, Tag } from "lucide-react";
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

/** Sentinel value used in the field selector to indicate a tag-type condition. */
const TAG_FIELD_SENTINEL = "__tag__";

const TAG_OPS = ["=", "!=", "matches"];

const isTagField = (field: string): boolean => field.startsWith("tag:");

const tagKeyFromField = (field: string): string => (isTagField(field) ? field.slice(4) : "");

const defaultValueForField = (field: string): unknown => {
  if (isTagField(field)) return "";
  const def = FIELD_DEFS.find((d) => d.field === field);
  if (!def) return "";
  if (def.valueType === "select") return def.options?.[0]?.value ?? "";
  return "";
};

// ── Tag suggestions hook ──────────────────────────────────────────

function useTagKeys(projectId?: string) {
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    fetch(`/api/projects/${projectId}/trace-tag-keys`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.keys) setKeys(data.keys as string[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return keys;
}

function useTagValues(projectId?: string, tagKey?: string) {
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => {
    if (!projectId || !tagKey) {
      setValues([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/projects/${projectId}/trace-tag-values?key=${encodeURIComponent(tagKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.values) setValues(data.values as string[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, tagKey]);
  return values;
}

// ── Autocomplete dropdown ─────────────────────────────────────────

function AutocompleteInput({
  value,
  onChange,
  suggestions,
  placeholder,
  className,
}: {
  value: string;
  onChange: (val: string) => void;
  suggestions: string[];
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  const filtered = suggestions.filter((s) =>
    s.toLowerCase().includes((filter || value).toLowerCase()),
  );

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [handleClickOutside]);

  return (
    <div ref={wrapperRef} className="relative flex-1">
      <Input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setFilter(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className={className}
      />
      {open && filtered.length > 0 && (
        <div className="absolute left-0 top-full z-50 mt-0.5 max-h-36 w-full overflow-y-auto rounded border border-border bg-popover shadow-md">
          {filtered.map((s) => (
            <button
              key={s}
              type="button"
              className="block w-full px-2 py-1 text-left text-[12px] hover:bg-accent"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s);
                setFilter("");
                setOpen(false);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── TriggerEditor component ───────────────────────────────────────

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
  /** When provided, enables tag-field autocomplete from recent traces in the project */
  projectId?: string;
}

export function TriggerEditor({
  conditions: initialConditions,
  onChange,
  onSave,
  isSaving,
  readOnly,
  asCard,
  projectId,
}: TriggerEditorProps) {
  const [conditions, setConditions] = useState<TriggerCondition[]>(initialConditions);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setConditions(initialConditions);
    setDirty(false);
  }, [initialConditions]);

  const tagKeys = useTagKeys(projectId);

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
          if (isTagField(patch.field)) {
            merged.op = TAG_OPS[0];
            merged.value = "";
          } else {
            const def = FIELD_DEFS.find((d) => d.field === patch.field);
            merged.op = def?.ops[0] ?? "=";
            merged.value = defaultValueForField(patch.field);
          }
        }
        return merged;
      }),
    );
  };

  /** Called when user selects a tag key in the tag-key autocomplete. */
  const handleTagKeyChange = (i: number, tagKey: string) => {
    updateCondition(i, { field: `tag:${tagKey}` });
  };

  const conditionRows = (
    <div className={`space-y-1.5 ${readOnly ? "pointer-events-none opacity-60" : ""}`}>
      {conditions.map((cond, i) => {
        const isTag = isTagField(cond.field);
        const fieldDef = isTag
          ? null
          : (FIELD_DEFS.find((d) => d.field === cond.field) ?? FIELD_DEFS[0]);
        // Determine which field selector value to show
        const selectorValue = isTag ? TAG_FIELD_SENTINEL : cond.field;
        const ops = isTag ? TAG_OPS : (fieldDef?.ops ?? ["="]);

        return (
          <div key={i} className="flex items-center gap-1.5">
            {/* Field */}
            <Select
              value={selectorValue}
              onValueChange={(val) => {
                if (val === TAG_FIELD_SENTINEL) {
                  updateCondition(i, { field: "tag:", op: TAG_OPS[0], value: "" });
                } else {
                  updateCondition(i, { field: val });
                }
              }}
            >
              <SelectTrigger className="h-7 w-[120px] shrink-0 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FIELD_DEFS.map((d) => (
                  <SelectItem key={d.field} value={d.field} className="text-[12px]">
                    {d.label}
                  </SelectItem>
                ))}
                <SelectItem value={TAG_FIELD_SENTINEL} className="text-[12px]">
                  Trace Tag
                </SelectItem>
              </SelectContent>
            </Select>

            {/* Tag key input — shown only for tag fields */}
            {isTag && (
              <AutocompleteInput
                value={tagKeyFromField(cond.field)}
                onChange={(key) => handleTagKeyChange(i, key)}
                suggestions={tagKeys}
                placeholder="tag key…"
                className="h-7 w-[110px] shrink-0 text-[12px]"
              />
            )}

            {/* Op */}
            <Select value={cond.op} onValueChange={(val) => updateCondition(i, { op: val })}>
              <SelectTrigger className="h-7 w-[70px] shrink-0 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ops.map((op) => (
                  <SelectItem key={op} value={op} className="text-[12px]">
                    {op}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Value */}
            {isTag ? (
              <TagValueInput
                projectId={projectId}
                tagKey={tagKeyFromField(cond.field)}
                value={cond.value as string}
                onChange={(val) => updateCondition(i, { value: val })}
              />
            ) : fieldDef?.valueType === "select" ? (
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

// ── Tag value input with autocomplete ─────────────────────────────

function TagValueInput({
  projectId,
  tagKey,
  value,
  onChange,
}: {
  projectId?: string;
  tagKey: string;
  value: string;
  onChange: (val: string) => void;
}) {
  const suggestions = useTagValues(projectId, tagKey);
  return (
    <AutocompleteInput
      value={value}
      onChange={onChange}
      suggestions={suggestions}
      placeholder="Enter value…"
      className="h-7 flex-1 text-[12px]"
    />
  );
}
