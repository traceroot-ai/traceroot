"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FieldLabel, SectionBox } from "@/features/dashboards/components/SectionBox";
import { getMeasureDoc } from "../measure-docs";
import {
  ALERT_MEASURES_BY_VIEW,
  getMeasure,
  getValidAggregations,
  type AlertAggregation,
  type AlertFilter,
  type AlertView,
} from "../rule-model";
import { AlertFilters } from "./alert-filters";
import { CONTROL_SIZE } from "./form-controls";
import { MeasureOption } from "./measure-option";

interface MetricSectionProps {
  projectId: string;
  view: AlertView;
  measureId: string;
  aggregation: AlertAggregation;
  filters: readonly AlertFilter[];
  onMeasureChange: (measureId: string) => void;
  onAggregationChange: (aggregation: AlertAggregation) => void;
  onFiltersChange: (filters: AlertFilter[]) => void;
}

/**
 * What the alert measures. The view is part of the rule but not part of the
 * form — only SPANS exists, and a one-option dropdown would be noise.
 */
export function MetricSection({
  projectId,
  view,
  measureId,
  aggregation,
  filters,
  onMeasureChange,
  onAggregationChange,
  onFiltersChange,
}: MetricSectionProps) {
  const measure = getMeasure(view, measureId);
  const validAggregations = measure ? getValidAggregations(measure) : [];

  return (
    <SectionBox label="Metric">
      {/* Scoped here rather than at the app root, matching how the repo mounts
          tooltip providers. Context still reaches the portalled dropdown. */}
      <TooltipProvider delayDuration={150}>
        <div className="flex flex-col gap-3 p-3">
          <div>
            <FieldLabel>Measure</FieldLabel>
            <Select value={measureId} onValueChange={onMeasureChange}>
              <SelectTrigger className={CONTROL_SIZE} aria-label="measure">
                <SelectValue placeholder="Measure" />
              </SelectTrigger>
              <SelectContent>
                {ALERT_MEASURES_BY_VIEW[view].map((m) => (
                  <MeasureOption key={m.id} measure={m} doc={getMeasureDoc(view, m.id)} />
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <FieldLabel>Aggregation</FieldLabel>
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
              <SelectTrigger className={CONTROL_SIZE} aria-label="aggregation">
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
          </div>
        </div>
        <div className="p-3">
          <FieldLabel>Filter</FieldLabel>
          <AlertFilters projectId={projectId} filters={filters} onFiltersChange={onFiltersChange} />
        </div>
      </TooltipProvider>
    </SectionBox>
  );
}
