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
      <div className="flex h-9 items-center border-b border-border px-4">
        <span className="text-[13px] font-medium text-foreground">Signals</span>
      </div>
      <div className="divide-y divide-border">
        <div className="flex items-center justify-between gap-4 p-4">
          <label htmlFor={`${idPrefix}-signals`} className="cursor-pointer">
            <span className="block text-[13px] font-medium text-foreground">Generate signals</span>
            <span className="block text-[12px] text-muted-foreground">
              Group related findings into signals.
            </span>
          </label>
          <Switch
            id={`${idPrefix}-signals`}
            checked={enableSignals}
            onCheckedChange={onEnableSignalsChange}
          />
        </div>
        <div className="p-4">
          <p className="mb-1.5 text-[13px] font-medium text-foreground">Root cause analysis</p>
          <div className="w-40">
            <Select
              value={mode}
              onValueChange={(v) => onEnableRcaChange(v === "automatic")}
              disabled={!enableSignals}
            >
              <SelectTrigger id={`${idPrefix}-rca`} aria-label="Root cause analysis">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">Manual</SelectItem>
                <SelectItem value="automatic">Automatic</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="mt-1.5 text-[12px] text-muted-foreground">
            {enableSignals
              ? RCA_MODE_HINT[mode]
              : "The agent runs from signals, so it needs Generate signals."}
          </p>
        </div>
        <div className="p-4">
          <p className="mb-1.5 text-[13px] font-medium text-foreground">Agent model</p>
          <AgentModelLink projectId={projectId} rcaModel={rcaModel} workspaceId={workspaceId} />
          <p className="mt-1.5 text-[12px] text-muted-foreground">Shared across this project.</p>
        </div>
      </div>
    </div>
  );
}
