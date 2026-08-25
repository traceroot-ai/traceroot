"use client";

import { useMemo } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import {
  Dropdown,
  DropdownItem,
  FIELD_UNIT,
  FieldDropdown,
  FilterControlSizeProvider,
  MetadataKeyCombobox,
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
  fieldsLoading = false,
}: {
  index: number;
  filter: { field: string; op: string; value: string | number; key?: string };
  filterableFields: [string, WidgetSchemaField][];
  fieldsMap: Record<string, WidgetSchemaField>;
  onChange: (
    idx: number,
    patch: Partial<{ field: string; op: string; value: string | number; key: string | undefined }>,
  ) => void;
  onRemove: (idx: number) => void;
  projectId: string;
  view: "spans" | "traces" | undefined;
  range: TimeRange;
  /**
   * The field registry has not answered yet. A saved row is shown as text with
   * a spinner until it does: rendered through the controls it would read as an
   * empty row, which is not the same thing as a row still being resolved.
   */
  fieldsLoading?: boolean;
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

  const subject = filter.key ? `${filter.field}[${filter.key}]` : filter.field;
  const predicateText = `${subject} ${filter.op} ${String(filter.value)}`;

  if (fieldsLoading && filter.field) {
    return (
      <div
        role="status"
        aria-label="Loading filter fields"
        className="flex h-7 items-center gap-2 rounded-md border border-dashed border-border px-2 text-[12px] text-muted-foreground"
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="truncate font-mono">{predicateText}</span>
        <span className="ml-auto shrink-0">Loading fields…</span>
      </div>
    );
  }

  // The registry answered and does not know this field: a saved filter whose
  // field was retired, or one this view never offered. Rendered through the
  // controls it would read as an empty row, so name it and keep it removable.
  if (!fieldsLoading && filter.field && !fieldMeta && filterableFields.length > 0) {
    return (
      <div
        role="alert"
        aria-label="Unknown filter field"
        className="flex h-7 items-center gap-2 rounded-md border border-dashed border-destructive/60 px-2 text-[12px] text-muted-foreground"
      >
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="truncate font-mono">{predicateText}</span>
        <span className="ml-auto shrink-0">Unknown field</span>
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

  return (
    // Both consumers' config columns run at 12px, so the shared controls
    // render at their compact size.
    <FilterControlSizeProvider size="sm">
      <div className="flex items-center gap-1">
        <FieldDropdown
          options={filterableFields.map(([key, meta]) => ({
            key,
            label: meta.label,
            icon: fieldIcon(key),
          }))}
          valueKey={filter.field || null}
          // Picking a field selects its first operator, like the trace-list builder,
          // and drops the map key it was typed for. Cleared to undefined, not "" --
          // the widget filter schema takes an absent key but rejects an empty one.
          onPick={(key) =>
            onChange(index, {
              field: key,
              op: fieldsMap[key]?.filterOps[0] ?? "",
              value: "",
              key: undefined,
            })
          }
        />

        {fieldMeta?.requiresKey && (
          <MetadataKeyCombobox
            projectId={projectId}
            startAfter={range.start.toISOString()}
            endBefore={range.end.toISOString()}
            value={filter.key ?? ""}
            onValue={(v) => onChange(index, { key: v })}
          />
        )}

        {/* op — labeled with the trace-list filter vocabulary (is / ≥ / ≤) */}
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
