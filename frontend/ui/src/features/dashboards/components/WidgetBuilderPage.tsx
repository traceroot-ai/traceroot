"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDashboard, useDashboardMutations } from "../hooks/use-dashboards";
import { useWidgetPreview, useWidgetSchema } from "../hooks/use-widget-data";
import { DEFAULT_RANGE_ID, RANGE_PRESETS, makeRange } from "../range-presets";
import { readStoredDateFilter, writeStoredDateFilter } from "@/lib/date-filter-storage";
import {
  BREAKDOWN_REQUIRED_DISPLAYS,
  DISPLAY_TYPES,
  FIELD_UNIT,
  generateWidgetTitle,
  isSpecComplete,
  parseSpec,
  type DraftSpec,
  type WidgetSchemaField,
} from "../types";
import { fieldIcon } from "./field-icons";
import { FilterRow } from "./FilterRow";
import { QueryWidgetRenderer } from "./renderers";

const ModelIcon = fieldIcon("model_name");

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

const NONE_SENTINEL = "__none__";

type View = "spans" | "traces";

const EMPTY_DRAFT: DraftSpec = { filters: [], breakdown: null };

// Section boxes match the detector creation form: square-cornered border with
// a muted header strip, sub-fields divided inside.
function SectionBox({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-border">
      <div className="border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="divide-y divide-border">{children}</div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{children}</p>;
}

export function WidgetBuilderPage({
  projectId,
  dashboardId,
  widgetId,
}: {
  projectId: string;
  dashboardId: string;
  widgetId?: string;
}) {
  const router = useRouter();
  const isEdit = widgetId !== undefined;
  const dashboardUrl = `/projects/${projectId}/dashboard/${dashboardId}`;

  const { data: dashboard, error: dashboardError } = useDashboard(projectId, dashboardId);
  const { createWidget, updateWidget } = useDashboardMutations(projectId, dashboardId);

  const [draft, setDraft] = useState<DraftSpec>(EMPTY_DRAFT);
  // Auto-name: `title` holds user text once locked; until then the generated
  // title is displayed. Edit mode starts locked — existing titles are user-owned.
  const [title, setTitle] = useState("");
  const [titleLocked, setTitleLocked] = useState(isEdit);

  // The preview shares the project's persisted date-filter selection: it
  // adopts the stored preset after mount (post-mount so hydration never
  // mismatches) and picking a preset here writes it back, carrying to the
  // dashboard and trace list too. The store may hold "custom", which the
  // preview's preset-only dropdown can't express — that stays at the shared
  // 24h default and is left untouched in the store.
  const [rangeId, setRangeId] = useState<string>(DEFAULT_RANGE_ID);
  useEffect(() => {
    const stored = readStoredDateFilter(projectId);
    if (stored && RANGE_PRESETS.some((p) => p.id === stored.id)) setRangeId(stored.id);
  }, [projectId]);
  const handleRangePick = (id: string) => {
    setRangeId(id);
    writeStoredDateFilter(projectId, { id });
  };
  const range = useMemo(() => makeRange(rangeId), [rangeId]);

  // ── edit mode: hydrate once the widget arrives, guard bad targets ─────────
  const widget = isEdit ? dashboard?.widgets.find((w) => w.id === widgetId) : undefined;
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!isEdit || hydrated || !widget) return;
    setDraft(widget.spec as DraftSpec);
    setTitle(widget.title);
    setHydrated(true);
  }, [isEdit, hydrated, widget]);

  useEffect(() => {
    if (dashboardError) router.replace(`/projects/${projectId}/dashboard`);
  }, [dashboardError, projectId, router]);

  useEffect(() => {
    if (isEdit && dashboard && (!widget || widget.type !== "query")) {
      router.replace(dashboardUrl);
    }
  }, [isEdit, dashboard, widget, dashboardUrl, router]);

  // The default dashboard is read-only — widgets can be neither added nor
  // edited, so bounce straight back. The API enforces the same rule.
  useEffect(() => {
    if (dashboard?.isDefault) router.replace(dashboardUrl);
  }, [dashboard, dashboardUrl, router]);

  // ── schema-driven field lists (same derivation as the old modal) ──────────
  const { data: schema } = useWidgetSchema(projectId);
  const view = draft.view as View | undefined;
  const viewFields: Record<string, WidgetSchemaField> = view ? (schema?.[view]?.fields ?? {}) : {};
  const pickFields = (pred: (f: WidgetSchemaField) => boolean) =>
    Object.entries(viewFields).filter(([, f]) => pred(f)) as [string, WidgetSchemaField][];
  const filterableFields = pickFields((f) => f.filterOps.length > 0);
  const measurableFields = pickFields((f) => f.aggs.length > 0);
  const groupableFields = pickFields((f) => f.groupable);

  function handleViewChange(v: View) {
    setDraft({ view: v, filters: [], breakdown: null });
  }

  // ── filters ────────────────────────────────────────────────────────────────
  const filters = draft.filters ?? [];

  // Filter rows use `op: string` while DraftSpec expects the strict op union.
  // Rows are partial/in-progress; parseSpec/isSpecComplete validates the final
  // shape — so we cast through unknown here to satisfy the type checker.
  function handleFilterChange(
    idx: number,
    patch: Partial<{ field: string; op: string; value: string | number }>,
  ) {
    setDraft(
      (d) =>
        ({
          ...d,
          filters: (d.filters ?? []).map((f, i) => (i === idx ? { ...f, ...patch } : f)),
        }) as unknown as DraftSpec,
    );
  }

  function handleFilterRemove(idx: number) {
    setDraft(
      (d) =>
        ({ ...d, filters: (d.filters ?? []).filter((_, i) => i !== idx) }) as unknown as DraftSpec,
    );
  }

  function handleAddFilter() {
    setDraft(
      (d) =>
        ({
          ...d,
          filters: [...(d.filters ?? []), { field: "", op: "", value: "" }],
        }) as unknown as DraftSpec,
    );
  }

  // ── metric / breakdown / display ──────────────────────────────────────────
  const measure = draft.metric?.measure ?? "";
  const agg = draft.metric?.agg ?? "";
  const measureMeta = viewFields[measure];
  const allowedAggs = measureMeta?.aggs ?? [];

  function handleMeasureChange(m: string) {
    const firstAgg = viewFields[m]?.aggs[0] ?? "";
    setDraft((d) => ({ ...d, metric: { measure: m, agg: firstAgg } }) as unknown as DraftSpec);
  }

  function handleAggChange(a: string) {
    setDraft(
      (d) =>
        ({ ...d, metric: { measure: d.metric?.measure ?? "", agg: a } }) as unknown as DraftSpec,
    );
  }

  function handleBreakdownChange(v: string) {
    const breakdown = v === NONE_SENTINEL ? null : v;
    // Model is span-level data but the most-wanted breakdown, so it's offered
    // from every view: picking it switches to Spans like a manual view change
    // (filters reset), keeping the metric when the measure exists there too.
    if (breakdown === "model_name" && view !== "spans") {
      const spansFields = schema?.spans?.fields ?? {};
      setDraft((d) => {
        const spansField = d.metric?.measure ? spansFields[d.metric.measure] : undefined;
        const metricSurvives =
          spansField && d.metric?.agg ? spansField.aggs.includes(d.metric.agg) : false;
        return {
          view: "spans",
          filters: [],
          breakdown,
          metric: metricSurvives ? d.metric : undefined,
          display: d.display,
        };
      });
      return;
    }
    setDraft((d) => ({ ...d, breakdown }));
  }

  function handleDisplayChange(t: (typeof DISPLAY_TYPES)[number]) {
    setDraft((d) => ({
      ...d,
      display: { type: t },
      // histogram has its own shape and a number tile shows a single value —
      // neither can express a breakdown, so clear it automatically
      ...(t === "histogram" || t === "number" ? { breakdown: null } : {}),
    }));
  }

  // ── name (auto until edited) ──────────────────────────────────────────────
  const effectiveTitle = titleLocked ? title : generateWidgetTitle(draft, viewFields);

  // ── preview ───────────────────────────────────────────────────────────────
  const debouncedDraft = useDebounced(draft, 400);
  const preview = useWidgetPreview(projectId, debouncedDraft, range);

  // ── save ──────────────────────────────────────────────────────────────────
  const specComplete = isSpecComplete(draft);
  // The schema tells us which measures the query engine can histogram
  // (count's expr is the count(*) sentinel, which it permanently rejects) —
  // without this gate the widget saves and then renders "Query failed"
  // forever on the dashboard.
  const measureField = draft.metric?.measure ? viewFields[draft.metric.measure] : undefined;
  const histogramBlocked =
    draft.display?.type === "histogram" && measureField?.histogrammable === false;
  const saving = createWidget.isPending || updateWidget.isPending;
  const canSave = specComplete && !histogramBlocked && effectiveTitle.trim().length > 0 && !saving;
  const saveError = createWidget.error ?? updateWidget.error;

  function handleSave() {
    const spec = parseSpec(draft);
    if (!spec) return;
    const payload = { title: effectiveTitle.trim(), spec };
    const onSuccess = () => router.push(dashboardUrl);
    if (isEdit) {
      if (!widget) return; // deleted from under us — the redirect guard takes over
      updateWidget.mutate({ widgetId: widget.id, ...payload }, { onSuccess });
    } else {
      createWidget.mutate({ ...payload, type: "query" }, { onSuccess });
    }
  }

  // Fall back to the default option so an unmatched id shows the same label
  // as the window makeRange actually builds for it.
  const activePreset =
    RANGE_PRESETS.find((p) => p.id === rangeId) ??
    RANGE_PRESETS.find((p) => p.id === DEFAULT_RANGE_ID)!;

  return (
    <div className="flex h-full flex-col text-[13px]">
      {/* header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link
          href={dashboardUrl}
          className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {dashboard?.name ?? "Dashboard"}
        </Link>
        <h1 className="text-[13px] font-medium">{isEdit ? "Edit widget" : "New widget"}</h1>
      </div>

      {/* body: config card left, preview right */}
      <div className="flex min-h-0 flex-1 gap-4 overflow-hidden p-4">
        {/* left: configuration column, sectioned like the detector form */}
        <div className="flex w-1/3 min-w-[340px] max-w-[420px] flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <SectionBox label="Data selection">
              <div className="p-3">
                <FieldLabel>View</FieldLabel>
                <Select value={view ?? ""} onValueChange={handleViewChange}>
                  <SelectTrigger className="h-7 text-[12px]">
                    <SelectValue placeholder="Select view" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="traces" className="text-[12px]">
                      Traces
                    </SelectItem>
                    <SelectItem value="spans" className="text-[12px]">
                      Spans
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="p-3">
                <FieldLabel>Filters</FieldLabel>
                <div className="flex flex-col gap-1.5">
                  {filters.map((f, i) => (
                    <FilterRow
                      key={i}
                      index={i}
                      filter={f as { field: string; op: string; value: string | number }}
                      filterableFields={filterableFields}
                      fieldsMap={viewFields}
                      onChange={handleFilterChange}
                      onRemove={handleFilterRemove}
                      projectId={projectId}
                      view={view}
                      range={range}
                    />
                  ))}
                  <button
                    type="button"
                    disabled={!view}
                    onClick={handleAddFilter}
                    className="mt-0.5 self-start text-[11.5px] text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ＋ Add filter
                  </button>
                </div>
              </div>

              <div className="p-3">
                <FieldLabel>Metric</FieldLabel>
                <div className="flex flex-col gap-1.5">
                  <Select value={measure} onValueChange={handleMeasureChange} disabled={!view}>
                    <SelectTrigger className="h-7 text-[12px]">
                      <SelectValue placeholder="Measure" />
                    </SelectTrigger>
                    <SelectContent>
                      {measurableFields.map(([key, meta]) => {
                        const Icon = fieldIcon(key);
                        return (
                          <SelectItem
                            key={key}
                            value={key}
                            className="text-[12px]"
                            icon={<Icon className="h-3.5 w-3.5 text-muted-foreground" />}
                          >
                            {meta.label}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                  <Select value={agg} onValueChange={handleAggChange} disabled={!measure}>
                    <SelectTrigger className="h-7 text-[12px]">
                      <SelectValue placeholder="Aggregation" />
                    </SelectTrigger>
                    <SelectContent>
                      {allowedAggs.map((a) => (
                        <SelectItem key={a} value={a} className="text-[12px]">
                          {a}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="p-3">
                <FieldLabel>Breakdown</FieldLabel>
                <Select
                  value={draft.breakdown ?? NONE_SENTINEL}
                  onValueChange={handleBreakdownChange}
                  disabled={
                    !view || draft.display?.type === "histogram" || draft.display?.type === "number"
                  }
                >
                  <SelectTrigger className="h-7 text-[12px]">
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE_SENTINEL} className="text-[12px]">
                      None
                    </SelectItem>
                    {groupableFields.map(([key, meta]) => {
                      const Icon = fieldIcon(key);
                      return (
                        <SelectItem
                          key={key}
                          value={key}
                          className="text-[12px]"
                          icon={<Icon className="h-3.5 w-3.5 text-muted-foreground" />}
                        >
                          {meta.label}
                        </SelectItem>
                      );
                    })}
                    {view !== "spans" && (
                      <SelectItem
                        value="model_name"
                        className="text-[12px]"
                        icon={<ModelIcon className="h-3.5 w-3.5 text-muted-foreground" />}
                      >
                        Model
                        <span className="ml-1 text-[10.5px] text-muted-foreground">· Spans</span>
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {(draft.display?.type === "histogram" || draft.display?.type === "number") && (
                  <p className="mt-1 text-[10.5px] text-muted-foreground">
                    Not available for this display type
                  </p>
                )}
                {draft.display?.type &&
                  BREAKDOWN_REQUIRED_DISPLAYS.has(draft.display.type) &&
                  !draft.breakdown && (
                    <p className="mt-1 text-[10.5px] text-amber-600">
                      A {draft.display.type} chart needs a breakdown dimension
                    </p>
                  )}
              </div>
            </SectionBox>

            <SectionBox label="Visualization">
              <div className="p-3">
                <FieldLabel>Display</FieldLabel>
                <div className="flex flex-wrap gap-1.5">
                  {DISPLAY_TYPES.map((t) => (
                    <Button
                      key={t}
                      type="button"
                      size="sm"
                      variant={draft.display?.type === t ? "default" : "outline"}
                      onClick={() => handleDisplayChange(t)}
                      // Entering the state is blocked when we already know the
                      // engine will reject it; the hint below covers reaching
                      // it the other way round (picking the measure last).
                      disabled={t === "histogram" && measureField?.histogrammable === false}
                      className="h-7 text-[12px]"
                    >
                      {t}
                    </Button>
                  ))}
                </div>
                {histogramBlocked && (
                  <p className="mt-1 text-[10.5px] text-amber-600">
                    {measureField?.label ?? draft.metric?.measure} can&apos;t be histogrammed — pick
                    another measure or display
                  </p>
                )}
              </div>

              <div className="p-3">
                <FieldLabel>Name</FieldLabel>
                <Input
                  className="h-7 text-[12px]"
                  placeholder="Widget name"
                  value={effectiveTitle}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setTitleLocked(true);
                  }}
                />
              </div>
            </SectionBox>
          </div>

          {/* footer */}
          <div className="flex flex-col gap-2 pt-3">
            {saveError ? (
              <p className="text-[11.5px] text-red-600">
                Failed to save widget
                {saveError instanceof Error ? `: ${saveError.message}` : ""}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Link
                href={dashboardUrl}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "h-7 text-[12px]",
                )}
              >
                Cancel
              </Link>
              <Button
                size="sm"
                className="h-7 text-[12px]"
                disabled={!canSave}
                onClick={handleSave}
              >
                Save widget
              </Button>
            </div>
          </div>
        </div>

        {/* right: preview card */}
        <div className="flex min-w-0 flex-1 flex-col border border-border">
          <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
            <span
              className="truncate text-[12px] font-medium text-muted-foreground"
              title={effectiveTitle}
            >
              {effectiveTitle || "Preview"}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-[12px]">
                  {activePreset.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {RANGE_PRESETS.map((preset) => (
                  <DropdownMenuItem
                    key={preset.id}
                    className="text-[12px]"
                    onClick={() => handleRangePick(preset.id)}
                  >
                    {preset.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="min-h-0 flex-1 p-4">
            {!specComplete ? (
              <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                Complete the data selection and display to preview
              </div>
            ) : preview.isPending ? (
              <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                Running…
              </div>
            ) : preview.error ? (
              <div className="flex h-full items-start justify-center pt-8 text-[12px] text-red-600">
                {preview.error instanceof Error ? preview.error.message : "Query failed"}
              </div>
            ) : preview.data ? (
              // Everything spec-derived comes from the spec that produced the
              // rows (preview.data.spec, not the live draft): keepPreviousData
              // can show the previous result while a new query is in flight,
              // and mixing old rows with the new draft's display/unit/agg
              // would briefly mislabel them.
              <QueryWidgetRenderer
                display={preview.data.spec.display.type}
                result={preview.data.result}
                unit={FIELD_UNIT[preview.data.spec.metric.measure]}
                seriesLabel={preview.data.spec.metric.measure}
                agg={preview.data.spec.metric.agg}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
