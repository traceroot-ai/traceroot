"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ALERT_WINDOWS, type AlertWindow } from "@traceroot/core";
import { cn } from "@/lib/utils";
import { SectionBox } from "@/features/dashboards/components/SectionBox";
import { getMeasureDoc } from "../measure-docs";
import {
  ALERT_MEASURES_BY_VIEW,
  ALERT_OPERATORS,
  ALERT_OPERATOR_LABELS,
  getAlertUnit,
  getMeasure,
  getValidAggregations,
  type AlertAggregation,
  type AlertOperator,
  type AlertView,
} from "../rule-model";
import { CONTROL_SIZE } from "./form-controls";
import { MeasureOption } from "./measure-option";

function Connective({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 text-[12px] text-muted-foreground">{children}</span>;
}

interface ConditionSectionProps {
  view: AlertView;
  measureId: string;
  aggregation: AlertAggregation;
  operator: AlertOperator;
  threshold: string;
  window: AlertWindow;
  onMeasureChange: (measureId: string) => void;
  onAggregationChange: (aggregation: AlertAggregation) => void;
  onOperatorChange: (operator: AlertOperator) => void;
  onThresholdChange: (threshold: string) => void;
  onWindowChange: (window: AlertWindow) => void;
}

/**
 * The single trigger condition, laid out as the sentence it is: aggregation of
 * measure, operator, value with its unit, over the last window. The measure
 * sits beside the value because it decides what the value means. One
 * threshold, no warning tier; a user who wants two levels creates two alerts.
 *
 * The window reads "over the last 10m": the token is a lookback, not a cadence.
 */
export function ConditionSection({
  view,
  measureId,
  aggregation,
  operator,
  threshold,
  window,
  onMeasureChange,
  onAggregationChange,
  onOperatorChange,
  onThresholdChange,
  onWindowChange,
}: ConditionSectionProps) {
  const measure = getMeasure(view, measureId);
  const validAggregations = measure ? getValidAggregations(measure, view) : [];
  const unit = getAlertUnit(measureId, aggregation, view);

  return (
    <SectionBox label="Condition">
      {/* Scoped here rather than at the app root, matching how the repo mounts
          tooltip providers. Context still reaches the portalled dropdown. */}
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center gap-1.5">
            <Select
              value={aggregation}
              // Radix re-syncs its hidden native select when the item list
              // swaps under a measure change and emits onValueChange("") for
              // the not-yet-remounted value. "" is never a legal aggregation.
              onValueChange={(a) => {
                if (a) onAggregationChange(a as AlertAggregation);
              }}
              disabled={validAggregations.length <= 1}
            >
              <SelectTrigger className={cn(CONTROL_SIZE, "w-20 shrink-0")} aria-label="aggregation">
                <SelectValue placeholder="Aggregation" />
              </SelectTrigger>
              <SelectContent>
                {validAggregations.map((a) => (
                  <SelectItem key={a} value={a} className="text-[12px]">
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Connective>of</Connective>
            <Select value={measureId} onValueChange={onMeasureChange}>
              <SelectTrigger className={cn(CONTROL_SIZE, "min-w-0 flex-1")} aria-label="measure">
                <SelectValue placeholder="Measure" />
              </SelectTrigger>
              <SelectContent>
                {ALERT_MEASURES_BY_VIEW[view].map((m) => (
                  <MeasureOption key={m.id} measure={m} doc={getMeasureDoc(view, m.id)} />
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* Wraps rather than squeezes: on a narrow viewport the window drops to
              its own line and the threshold keeps a width it can be typed in. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Select value={operator} onValueChange={(o) => onOperatorChange(o as AlertOperator)}>
              <SelectTrigger className={cn(CONTROL_SIZE, "w-14 shrink-0")} aria-label="operator">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALERT_OPERATORS.map((o) => (
                  <SelectItem key={o} value={o} className="text-[12px]">
                    {ALERT_OPERATOR_LABELS[o]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* The unit lives inside the field's border so it reads as part of
                the value. A bare input, not NumberField: that one refuses
                negatives, and a threshold may be one. */}
            <div
              className={cn(
                CONTROL_SIZE,
                "flex min-w-[5.5rem] flex-1 items-center gap-1 rounded-md border border-input bg-transparent px-2 shadow-sm focus-within:ring-1 focus-within:ring-ring",
              )}
            >
              {unit?.prefix && (
                <span className="shrink-0 text-muted-foreground">{unit.prefix}</span>
              )}
              <input
                type="number"
                value={threshold}
                onChange={(e) => onThresholdChange(e.target.value)}
                placeholder="Threshold"
                aria-label="threshold"
                required
                step="any"
                className="min-w-0 flex-1 bg-transparent outline-none [appearance:textfield] placeholder:text-muted-foreground [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              {unit?.suffix && (
                <span className="shrink-0 text-muted-foreground">{unit.suffix}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Connective>over the last</Connective>
              <Select value={window} onValueChange={(w) => onWindowChange(w as AlertWindow)}>
                <SelectTrigger
                  className={cn(CONTROL_SIZE, "w-[4.5rem] shrink-0")}
                  aria-label="window"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ALERT_WINDOWS) as AlertWindow[]).map((w) => (
                    <SelectItem key={w} value={w} className="text-[12px]">
                      {w}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </TooltipProvider>
    </SectionBox>
  );
}
