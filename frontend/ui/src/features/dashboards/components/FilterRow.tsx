"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWidgetFieldValues } from "../hooks/use-widget-data";
import {
  FIELD_UNIT,
  filterOpLabel,
  isEnumerableFilter,
  type TimeRange,
  type WidgetSchemaField,
} from "../types";

export function FilterRow({
  index,
  filter,
  filterableFields,
  fieldsMap,
  onChange,
  onRemove,
  projectId,
  view,
  range,
}: {
  index: number;
  filter: { field: string; op: string; value: string | number };
  filterableFields: [string, WidgetSchemaField][];
  fieldsMap: Record<string, WidgetSchemaField>;
  onChange: (
    idx: number,
    patch: Partial<{ field: string; op: string; value: string | number }>,
  ) => void;
  onRemove: (idx: number) => void;
  projectId: string;
  view: "spans" | "traces" | undefined;
  range: TimeRange;
}) {
  const fieldMeta = fieldsMap[filter.field];
  const ops = fieldMeta?.filterOps ?? [];
  const isNumeric = fieldMeta?.type === "number";

  // Equality on a string dimension offers the field's stored values as a
  // dropdown; contains and numeric comparisons stay free inputs.
  const enumerable = isEnumerableFilter(fieldMeta, filter.op);
  const { values, isLoading } = useWidgetFieldValues(
    projectId,
    view,
    filter.field,
    range,
    enumerable,
  );

  // Keep a previously-saved value selectable even when it no longer occurs in
  // the active window's stored values.
  const options = useMemo(() => {
    const stored = values.map((v) => v.value);
    const current = String(filter.value);
    return current && !stored.includes(current) ? [current, ...stored] : stored;
  }, [values, filter.value]);

  const showValueDropdown = enumerable && (options.length > 0 || isLoading);

  return (
    <div className="flex items-center gap-1.5">
      {/* field */}
      <Select
        value={filter.field}
        onValueChange={(v) => onChange(index, { field: v, op: "", value: "" })}
      >
        <SelectTrigger className="h-7 flex-1 text-[12px]">
          <SelectValue placeholder="Field" />
        </SelectTrigger>
        <SelectContent>
          {filterableFields.map(([key, meta]) => (
            <SelectItem key={key} value={key} className="text-[12px]">
              {meta.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* op — labeled with the trace-list filter vocabulary (is / is not / ≥ / ≤ / ≠) */}
      <Select
        value={filter.op}
        onValueChange={(v) => onChange(index, { op: v })}
        disabled={!filter.field}
      >
        <SelectTrigger className="h-7 w-24 text-[12px]">
          <SelectValue placeholder="Op">
            {filter.op ? filterOpLabel(fieldMeta, filter.op) : undefined}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op} className="text-[12px]">
              {filterOpLabel(fieldMeta, op)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* value */}
      {showValueDropdown ? (
        <Select value={String(filter.value)} onValueChange={(v) => onChange(index, { value: v })}>
          <SelectTrigger className="h-7 flex-1 text-[12px]">
            <SelectValue placeholder={isLoading ? "Loading…" : "Value"} />
          </SelectTrigger>
          <SelectContent>
            {options.map((v) => (
              <SelectItem key={v} value={v} className="text-[12px]">
                {v}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="flex flex-1 items-center gap-1">
          {isNumeric && FIELD_UNIT[filter.field]?.prefix && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {FIELD_UNIT[filter.field].prefix}
            </span>
          )}
          <Input
            className="h-7 flex-1 text-[12px]"
            placeholder="Value"
            type={isNumeric ? "number" : "text"}
            value={String(filter.value)}
            onChange={(e) => {
              const raw = e.target.value;
              onChange(index, { value: isNumeric && raw !== "" ? Number(raw) : raw });
            }}
            disabled={!filter.field}
          />
          {isNumeric && FIELD_UNIT[filter.field]?.suffix && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {FIELD_UNIT[filter.field].suffix}
            </span>
          )}
        </div>
      )}

      {/* remove */}
      <button
        type="button"
        onClick={() => onRemove(index)}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Remove filter"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
