"use client";

import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { FilterRow, type FilterRowPatch } from "@/features/dashboards/components/FilterRow";
import { useWidgetSchema } from "@/features/dashboards/hooks/use-widget-data";
import type { WidgetSchemaField } from "@/features/dashboards/types";
import { ALERT_FILTER_OPERATORS_BY_FIELD } from "@traceroot/core";
import { ALERT_FILTER_FIELDS, EMPTY_ALERT_FILTER, type AlertFilter } from "../rule-model";
import { FILTER_VALUE_LOOKBACK_MS } from "../preview";

interface AlertFiltersProps {
  projectId: string;
  filters: readonly AlertFilter[];
  onFiltersChange: (filters: AlertFilter[]) => void;
}

/**
 * Which spans the alert measures. The field list is the intersection of
 * `ALERT_FILTER_FIELDS` and what the widget engine's live schema reports as
 * filterable: the preview compiles through that engine, so offering a field it
 * will not filter on would chart a different query from the one the alert runs.
 */
export function AlertFilters({ projectId, filters, onFiltersChange }: AlertFiltersProps) {
  const {
    data: schema,
    isPending: isSchemaPending,
    isError: isSchemaError,
  } = useWidgetSchema(projectId);
  const spansFields = schema?.spans.fields;

  const filterableFields = useMemo<[string, WidgetSchemaField][]>(
    () =>
      ALERT_FILTER_FIELDS.flatMap((key) => {
        const meta = spansFields?.[key];
        if (!meta) return [];
        // The engine filters on more operators than an alert stores (`in`), so
        // the row offers only the ones the alert API accepts for the field.
        const filterOps = meta.filterOps.filter((op) =>
          (ALERT_FILTER_OPERATORS_BY_FIELD[key] as readonly string[]).includes(op),
        );
        return filterOps.length > 0
          ? [[key, { ...meta, filterOps }] as [string, WidgetSchemaField]]
          : [];
      }),
    [spansFields],
  );
  const fieldsMap = useMemo(
    () => Object.fromEntries(filterableFields),
    [filterableFields],
  ) as Record<string, WidgetSchemaField>;

  // Captured once per mount: a fresh "now" per render would mint a new query
  // key per keystroke.
  const [range] = useState(() => {
    const end = new Date();
    return { start: new Date(end.getTime() - FILTER_VALUE_LOOKBACK_MS), end };
  });

  // The row offers no `in` here (see filterableFields), so no patch carries a
  // list value and every patch is an alert filter's.
  const handleChange = (index: number, patch: FilterRowPatch) => {
    onFiltersChange(
      filters.map((f, i) => (i === index ? { ...f, ...(patch as Partial<AlertFilter>) } : f)),
    );
  };

  const handleRemove = (index: number) => {
    onFiltersChange(filters.filter((_, i) => i !== index));
  };

  const handleAdd = () => {
    onFiltersChange([...filters, { ...EMPTY_ALERT_FILTER }]);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {filters.map((filter, index) => (
        <FilterRow
          key={index}
          index={index}
          filter={filter}
          filterableFields={filterableFields}
          fieldsMap={fieldsMap}
          onChange={handleChange}
          onRemove={handleRemove}
          projectId={projectId}
          view="spans"
          range={range}
          // Pending: a saved row must not read as unknown before the registry
          // has had its say. Failed with nothing cached: it says so, and stays
          // removable. A failed background refetch keeps the cached schema,
          // which is still the registry — the rows stay editable.
          fieldsLoading={isSchemaPending}
          fieldsUnavailable={isSchemaError && schema === undefined}
        />
      ))}
      {/* Disabled until the schema answers: an empty field dropdown is a dead
          end, not a choice. */}
      <button
        type="button"
        disabled={filterableFields.length === 0}
        onClick={handleAdd}
        className="mt-0.5 flex items-center gap-1 self-start text-[12px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus className="h-3.5 w-3.5" />
        Add filter
      </button>
    </div>
  );
}
