"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import {
  Dropdown,
  DropdownItem,
  FIELD_UNIT,
  FieldDropdown,
  FilterControlSizeProvider,
  NumberField,
  ParkedValueField,
  TextField,
  ValueDropdown,
} from "@/features/filters/filter-controls";
import { fieldIcon } from "./field-icons";
import { useWidgetFieldValues } from "../hooks/use-widget-data";
import {
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
  // the active window's stored values (it gets no count, marking it as stale).
  const options = useMemo(() => {
    const current = String(filter.value);
    const hasCurrent = values.some((v) => v.value === current);
    return current && !hasCurrent ? [{ value: current }, ...values] : values;
  }, [values, filter.value]);

  const showValueDropdown = enumerable && (options.length > 0 || isLoading);

  return (
    // The widget builder's config column runs at 12px, so the shared controls
    // render at their compact size here.
    <FilterControlSizeProvider size="sm">
      <div className="flex items-center gap-1">
        <FieldDropdown
          options={filterableFields.map(([key, meta]) => ({
            key,
            label: meta.label,
            icon: fieldIcon(key),
          }))}
          valueKey={filter.field || null}
          // Picking a field selects its first operator, like the trace-list builder.
          onPick={(key) =>
            onChange(index, { field: key, op: fieldsMap[key]?.filterOps[0] ?? "", value: "" })
          }
        />

        {/* op — labeled with the trace-list filter vocabulary (is / is not / ≥ / ≤ / ≠) */}
        <Dropdown
          disabled={!fieldMeta}
          trigger={
            <span className="whitespace-nowrap">
              {fieldMeta && filter.op ? filterOpLabel(fieldMeta, filter.op) : "is"}
            </span>
          }
          triggerClassName="min-w-[3.5rem] shrink-0"
          contentClassName="w-28"
        >
          {(close) =>
            (fieldMeta?.filterOps ?? []).map((op) => (
              <DropdownItem
                key={op}
                active={op === filter.op}
                onClick={() => {
                  onChange(index, { op });
                  close();
                }}
              >
                {filterOpLabel(fieldMeta, op)}
              </DropdownItem>
            ))
          }
        </Dropdown>

        {/* value — same controls as the trace-list builder's ValueControl */}
        {!fieldMeta ? (
          <ParkedValueField />
        ) : showValueDropdown ? (
          <ValueDropdown
            value={String(filter.value)}
            options={options}
            onValue={(v) => onChange(index, { value: v })}
            placeholder={isLoading ? "Loading…" : undefined}
          />
        ) : isNumeric ? (
          <NumberField
            ariaLabel="value"
            placeholder="Enter value"
            value={String(filter.value)}
            onChange={(v) => onChange(index, { value: v === "" ? "" : Number(v) })}
            unit={FIELD_UNIT[filter.field]}
          />
        ) : (
          <TextField
            ariaLabel="value"
            placeholder="Enter value"
            value={String(filter.value)}
            onChange={(v) => onChange(index, { value: v })}
          />
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
    </FilterControlSizeProvider>
  );
}
