"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ALERT_WINDOWS, type AlertWindow } from "@traceroot/core";
import { cn } from "@/lib/utils";
import { FieldLabel, SectionBox } from "@/features/dashboards/components/SectionBox";
import {
  ALERT_OPERATORS,
  ALERT_OPERATOR_LABELS,
  ALERT_RENOTIFY_MAX_MINUTES,
  ALERT_RENOTIFY_MIN_MINUTES,
  DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
  clampRenotifyInterval,
  type AlertOperator,
  type AlertRenotify,
} from "../rule-model";
import { CONTROL_SIZE } from "./form-controls";

interface RenotifyIntervalFieldProps {
  intervalMinutes: number;
  onIntervalChange: (intervalMinutes: number) => void;
}

/**
 * The raw input string is the state the user types into, as with threshold, and
 * only a value that survives the clamp unchanged is handed up. Clamping every
 * keystroke instead turns a cleared field into 1 and the next digit into 1x.
 */
function RenotifyIntervalField({ intervalMinutes, onIntervalChange }: RenotifyIntervalFieldProps) {
  const [draft, setDraft] = useState(String(intervalMinutes));

  const handleChange = (value: string) => {
    setDraft(value);
    const parsed = Number(value);
    if (clampRenotifyInterval(parsed) === parsed) onIntervalChange(parsed);
  };

  // Blank or unparseable leaves the last committed interval standing rather
  // than inventing one.
  const handleBlur = () => {
    const parsed = Number(draft);
    const next =
      draft.trim() === "" || !Number.isFinite(parsed)
        ? intervalMinutes
        : clampRenotifyInterval(parsed);
    setDraft(String(next));
    onIntervalChange(next);
  };

  return (
    <div>
      <FieldLabel>Re-alert every (minutes)</FieldLabel>
      <Input
        type="number"
        value={draft}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        aria-label="renotify interval"
        min={ALERT_RENOTIFY_MIN_MINUTES}
        max={ALERT_RENOTIFY_MAX_MINUTES}
        step="1"
        className={CONTROL_SIZE}
      />
    </div>
  );
}

interface ConditionSectionProps {
  operator: AlertOperator;
  threshold: string;
  window: AlertWindow;
  renotify: AlertRenotify;
  onOperatorChange: (operator: AlertOperator) => void;
  onThresholdChange: (threshold: string) => void;
  onWindowChange: (window: AlertWindow) => void;
  onRenotifyChange: (renotify: AlertRenotify) => void;
}

/**
 * The single trigger condition. One threshold, no warning tier; a user who
 * wants two levels creates two alerts.
 *
 * Window items read "Last 10m", not the detector settings' "Every 10m": the
 * token is a lookback, and a cadence label would promise a notification rate
 * this field does not control. Renotify is the field that does, hence its place
 * here rather than in the notifications section.
 */
export function ConditionSection({
  operator,
  threshold,
  window,
  renotify,
  onOperatorChange,
  onThresholdChange,
  onWindowChange,
  onRenotifyChange,
}: ConditionSectionProps) {
  return (
    <SectionBox label="Conditions">
      <div className="p-3">
        <FieldLabel>Trigger</FieldLabel>
        <div className="flex gap-1.5">
          <Select value={operator} onValueChange={(o) => onOperatorChange(o as AlertOperator)}>
            <SelectTrigger className={cn(CONTROL_SIZE, "w-36 shrink-0")} aria-label="operator">
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
          <Input
            type="number"
            value={threshold}
            onChange={(e) => onThresholdChange(e.target.value)}
            placeholder="Threshold"
            aria-label="threshold"
            required
            step="any"
            className={cn(CONTROL_SIZE, "min-w-0 flex-1")}
          />
        </div>
      </div>
      <div className="p-3">
        <FieldLabel>Window</FieldLabel>
        <Select value={window} onValueChange={(w) => onWindowChange(w as AlertWindow)}>
          <SelectTrigger className={CONTROL_SIZE} aria-label="window">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ALERT_WINDOWS) as AlertWindow[]).map((w) => (
              <SelectItem key={w} value={w} className="text-[12px]">
                {`Last ${w}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="p-3">
        <div className="flex flex-col gap-3">
          <div>
            <FieldLabel>Renotify</FieldLabel>
            <Select
              value={renotify.mode}
              // A mode change builds a new renotify rather than editing one,
              // so "off" can never carry a stale interval.
              onValueChange={(mode) =>
                onRenotifyChange(
                  mode === "EVERY"
                    ? {
                        mode: "EVERY",
                        intervalMinutes: DEFAULT_ALERT_RENOTIFY_INTERVAL_MINUTES,
                      }
                    : { mode: "OFF" },
                )
              }
            >
              <SelectTrigger className={CONTROL_SIZE} aria-label="renotify">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="OFF" className="text-[12px]">
                  Off (alert only on transitions)
                </SelectItem>
                <SelectItem value="EVERY" className="text-[12px]">
                  Re-alert at a regular interval
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {renotify.mode === "EVERY" && (
            <RenotifyIntervalField
              intervalMinutes={renotify.intervalMinutes}
              onIntervalChange={(intervalMinutes) =>
                onRenotifyChange({ mode: "EVERY", intervalMinutes })
              }
            />
          )}
        </div>
      </div>
    </SectionBox>
  );
}
