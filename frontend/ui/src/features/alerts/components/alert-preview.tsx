"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Label,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type DotItemDotProps,
} from "recharts";
import { ALERT_WINDOWS, type AlertWindow } from "@traceroot/core";
import { FIELD_UNIT } from "@/features/filters/filter-controls";
import {
  useWidgetPreview,
  type WidgetPreviewData,
} from "@/features/dashboards/hooks/use-widget-data";
import {
  ChartTip,
  SERIES_COLORS,
  bucketLabel,
  fmtAxisTick,
  isAdditiveAgg,
  seriesNameFormatter,
  pivotRows,
} from "@/features/dashboards/components/renderers";
import { DateFilterSelect } from "@/components/date-filter-select";
import { makeRange } from "@/features/dashboards/range-presets";
import { DEFAULT_DATE_FILTER, type DateFilterOption } from "@/lib/date-filter";
import type { TimeRange } from "@/features/dashboards/types";
import type { AlertAggregation, AlertFilter, AlertOperator, AlertView } from "../rule-model";
import { buildPreviewSpec, parseThreshold } from "../preview";

interface AlertPreviewProps {
  projectId: string;
  view: AlertView;
  measureId: string;
  aggregation: AlertAggregation;
  // The chart has to carry these or it describes a broader query than the alert runs.
  filters?: readonly AlertFilter[];
  operator: AlertOperator;
  threshold: string;
  // The rule's window is the chart's bucket. Required rather than defaulted: a
  // default here is a chart drawn on a grain the rule does not evaluate.
  window: AlertWindow;
}

// Red is reserved for the threshold and the breach; the series takes palette entry 1.
const PREVIEW_SERIES_COLOR = SERIES_COLORS[1];

const DAY_MS = 86_400_000;

// Mirrors MAX_EXPLICIT_BUCKETS in backend/rest/services/widget_query.py, which
// rejects a range the rule's window divides into more points than this.
const MAX_PREVIEW_BUCKETS = 500;

function rangeFor(
  option: DateFilterOption,
  customStart: Date | null,
  customEnd: Date | null,
): TimeRange {
  if (option.isCustom && customStart && customEnd) {
    return { start: customStart, end: customEnd };
  }
  return makeRange(option.id);
}

// Applied as a text color so the SVG inherits it through currentColor: CSS
// variables do not substitute inside SVG presentation attributes.
const THRESHOLD_GRAPHIC_CLASS = "text-destructive";

// The destructive token lands near 3.8:1, under the 4.5:1 text needs, so the
// label steps one shade darker on light and lighter on dark.
const THRESHOLD_TEXT_CLASS = "text-red-700 dark:text-red-400";

/**
 * Null for an equality condition, which is a value rather than a side. The
 * label takes the quiet side, so a breaching spike never draws over it.
 */
function breachSide(operator: AlertOperator): "above" | "below" | null {
  if (operator === ">" || operator === ">=") return "above";
  if (operator === "<" || operator === "<=") return "below";
  return null;
}

function PreviewMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
      {children}
    </div>
  );
}

function PreviewChart({
  data,
  thresholdValue,
  operator,
  bucketMs,
}: {
  data: WidgetPreviewData;
  thresholdValue: number | null;
  operator: AlertOperator;
  bucketMs: number;
}) {
  const { spec, result } = data;
  const additive = isAdditiveAgg(spec.metric.agg);
  const unit = FIELD_UNIT[spec.metric.measure];
  const { data: rows } = useMemo(
    () => pivotRows(result.columns, result.rows, additive ? 0 : null),
    [result, additive],
  );

  const { isolatedPoints, hasValue } = useMemo(() => {
    const valueAt = (i: number) => rows[i]?.value ?? null;
    const indexes = rows.map((_, i) => i);
    return {
      // A measurement with a gap on either side spans no line segment, so
      // without a dot it is not drawn at all.
      isolatedPoints: new Set(
        indexes.filter(
          (i) => valueAt(i) !== null && valueAt(i - 1) === null && valueAt(i + 1) === null,
        ),
      ),
      hasValue: indexes.some((i) => valueAt(i) !== null),
    };
  }, [rows]);

  const side = breachSide(operator);
  // An inclusive operator draws solid, an exclusive one dashed, so the line
  // itself says whether the threshold value is in or out.
  const isInclusive = operator === ">=" || operator === "<=" || operator === "=";

  // A range with nothing measured in it densifies to all-null rows, which the
  // chart would still draw as bare axes.
  if (!hasValue) {
    return <PreviewMessage>No data in range</PreviewMessage>;
  }

  return (
    // The axes inherit currentColor; the threshold elements override it below.
    <div className="h-full text-muted-foreground">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeOpacity={0.15} vertical={false} />
          <XAxis
            dataKey="bucket"
            tick={{ fontSize: 10 }}
            tickFormatter={
              bucketMs >= DAY_MS
                ? (v: unknown) => String(v).slice(5, 10)
                : (v: unknown) => String(v).slice(5, 16).replace("T", " ")
            }
          />
          {/* Widths mirror the dashboard renderers' tick gutters. */}
          <YAxis
            tick={{ fontSize: 10 }}
            width={unit ? 58 : 42}
            tickFormatter={(v: unknown) => fmtAxisTick(v, unit)}
          />
          <Tooltip
            isAnimationActive={false}
            filterNull={false}
            content={
              <ChartTip
                nameFormatter={seriesNameFormatter(spec.metric.measure)}
                labelFormatter={bucketLabel}
                unit={unit}
              />
            }
          />
          {/* A lone bound extends to the OPPOSITE edge from the one its name
              suggests: y2 alone runs from the top of the plot down to the
              value, y1 alone from the value down to the bottom. */}
          {thresholdValue !== null && side !== null && (
            <ReferenceArea
              className={THRESHOLD_GRAPHIC_CLASS}
              {...(side === "above" ? { y2: thresholdValue } : { y1: thresholdValue })}
              ifOverflow="extendDomain"
              fill="currentColor"
              fillOpacity={0.14}
              stroke="none"
            />
          )}
          {thresholdValue !== null && (
            <ReferenceLine
              className={THRESHOLD_GRAPHIC_CLASS}
              y={thresholdValue}
              stroke="currentColor"
              strokeWidth={1.5}
              strokeDasharray={isInclusive ? undefined : "4 4"}
              // Keep the line visible when the threshold sits above the data.
              ifOverflow="extendDomain"
            >
              <Label
                className={THRESHOLD_TEXT_CLASS}
                value={`Alert ${operator} ${thresholdValue}`}
                position={side === "below" ? "insideBottomLeft" : "insideTopLeft"}
                fill="currentColor"
                fontSize={12}
                fontWeight={600}
              />
            </ReferenceLine>
          )}
          <Line
            dataKey="value"
            stroke={PREVIEW_SERIES_COLOR}
            dot={(props: DotItemDotProps) =>
              isolatedPoints.has(props.index) ? (
                <circle
                  key={props.key}
                  cx={props.cx}
                  cy={props.cy}
                  r={2.5}
                  fill={PREVIEW_SERIES_COLOR}
                />
              ) : null
            }
            strokeWidth={1.5}
            isAnimationActive={false}
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * A combination the engine cannot run shows an unavailable message rather than
 * fabricated data.
 */
export function AlertPreview({
  projectId,
  view,
  measureId,
  aggregation,
  filters,
  operator,
  threshold,
  window,
}: AlertPreviewProps) {
  const spec = buildPreviewSpec(view, measureId, aggregation, filters);
  const bucketMs = ALERT_WINDOWS[window];
  const [dateFilter, setDateFilter] = useState(DEFAULT_DATE_FILTER);
  const [customStart, setCustomStart] = useState<Date | null>(null);
  const [customEnd, setCustomEnd] = useState<Date | null>(null);
  const range = useMemo(
    () => rangeFor(dateFilter, customStart, customEnd),
    [dateFilter, customStart, customEnd],
  );
  // Past the cap the server picks the grain instead, which beats a 422.
  const fitsBucket = range.end.getTime() - range.start.getTime() <= bucketMs * MAX_PREVIEW_BUCKETS;
  const preview = useWidgetPreview(
    projectId,
    spec,
    range,
    fitsBucket ? bucketMs / 1000 : undefined,
  );

  const thresholdValue = parseThreshold(threshold);

  return (
    <div className="flex min-h-[320px] min-w-0 flex-1 flex-col border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">Live preview</span>
        <DateFilterSelect
          dateFilter={dateFilter}
          customStartDate={customStart}
          customEndDate={customEnd}
          onDateFilterChange={setDateFilter}
          onCustomRangeChange={(start, end) => {
            setCustomStart(start);
            setCustomEnd(end);
          }}
          className="h-7 min-w-0 text-[12px]"
        />
      </div>
      <div className="min-h-0 flex-1 p-4">
        {spec === null ? (
          <PreviewMessage>No preview available for this metric yet.</PreviewMessage>
        ) : preview.isPending ? (
          <PreviewMessage>Running...</PreviewMessage>
        ) : preview.error ? (
          <PreviewMessage>Preview failed to load.</PreviewMessage>
        ) : preview.data ? (
          <PreviewChart
            data={preview.data}
            thresholdValue={thresholdValue}
            operator={operator}
            bucketMs={bucketMs}
          />
        ) : null}
      </div>
    </div>
  );
}
