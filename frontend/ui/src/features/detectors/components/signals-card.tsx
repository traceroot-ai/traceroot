"use client";

import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AgentModelLink } from "./agent-model-link";

/** How a detector's signals get their root cause analysis (the detector's enableRca). */
export type RcaMode = "manual" | "automatic";

const RCA_MODE_HINT: Record<RcaMode, string> = {
  manual: "Run the agent from a signal when you need it.",
  automatic: "Run the agent when a signal is created or reopened.",
};

interface SignalsCardProps {
  /** Prefix for the controls' ids, unique per form. */
  idPrefix: string;
  enableSignals: boolean;
  onEnableSignalsChange: (enabled: boolean) => void;
  /** enableRca: true runs the agent automatically, false only when asked from a signal. */
  enableRca: boolean;
  onEnableRcaChange: (enabled: boolean) => void;
  projectId: string;
  rcaModel?: string | null;
  workspaceId?: string;
}

/**
 * The detector form's Signals section, shared by the create form and the edit
 * panel: whether hits are grouped into signals, how a signal's root cause
 * analysis runs, and the project's agent model that runs it. Turning grouping
 * on groups hits detected from then on, never earlier ones.
 */
export function SignalsCard({
  idPrefix,
  enableSignals,
  onEnableSignalsChange,
  enableRca,
  onEnableRcaChange,
  projectId,
  rcaModel,
  workspaceId,
}: SignalsCardProps) {
  const mode: RcaMode = enableRca ? "automatic" : "manual";
  return (
    <div className="border border-border">
      <div className="border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[12px] font-medium text-muted-foreground">Signals</span>
      </div>
      <div className="divide-y divide-border">
        <div className="flex flex-col gap-2 p-3">
          <label
            htmlFor={`${idPrefix}-signals`}
            className="cursor-pointer text-[11px] text-muted-foreground"
          >
            <span className="font-medium text-foreground">Generate signals</span>
            <br />
            Group related findings into signals.
          </label>
          <Switch
            id={`${idPrefix}-signals`}
            checked={enableSignals}
            onCheckedChange={onEnableSignalsChange}
          />
        </div>
        <div className="p-3">
          <p className="mb-1.5 text-[11px] font-medium text-foreground">Root cause analysis</p>
          <Select
            value={mode}
            onValueChange={(v) => onEnableRcaChange(v === "automatic")}
            disabled={!enableSignals}
          >
            <SelectTrigger
              id={`${idPrefix}-rca`}
              className="h-7 w-[160px] text-[12px]"
              aria-label="Root cause analysis"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="manual" className="text-[12px]">
                Manual
              </SelectItem>
              <SelectItem value="automatic" className="text-[12px]">
                Automatic
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {enableSignals
              ? RCA_MODE_HINT[mode]
              : "The agent runs from signals, so it needs Generate signals."}
          </p>
        </div>
        <div className="p-3">
          <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">Agent Model</p>
          <AgentModelLink projectId={projectId} rcaModel={rcaModel} workspaceId={workspaceId} />
          <p className="mt-1 text-[11px] text-muted-foreground">Shared across this project.</p>
        </div>
      </div>
    </div>
  );
}
