import { TASK_GROUPS_LABEL } from "@traceroot/core/task-groups";
import { Button } from "@/components/ui/button";
import type { TaskGroupsOverview } from "../types";

function usd(value: number): string {
  return `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

/**
 * What the pipeline is doing, in words, when it is not simply showing groups: off, no model
 * key, over the day's spend cap, or still waiting for enough summaries.
 */
export function TopicsStatusPanel({
  overview,
  canChange,
  turningOn,
  onTurnOn,
}: {
  overview: TaskGroupsOverview;
  canChange: boolean;
  turningOn: boolean;
  onTurnOn: () => void;
}) {
  const { state, minDigests, digestsInWindow } = overview;
  const base = "border-b border-border bg-muted/30 px-4 py-3 text-[12px]";

  if (state.status === "off") {
    return (
      <div className={base} role="status">
        <p className="text-[13px] font-medium text-foreground">
          {TASK_GROUPS_LABEL} is off for this project
        </p>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          Turn it on to summarize a sample of up to 300 traces a day with a language model and group
          them by the task they were asked to do. It costs a little: summaries stop for the day at a
          spend cap of {usd(state.dailyCostCapUsd)}. Nothing is read or sent until you turn it on.
        </p>
        {canChange && (
          <Button
            size="sm"
            className="mt-2 h-7 text-[12px]"
            disabled={turningOn}
            onClick={onTurnOn}
          >
            Turn on
          </Button>
        )}
      </div>
    );
  }

  if (state.status === "no_key") {
    return (
      <div className={base} role="status">
        <p className="text-[13px] font-medium text-foreground">
          {TASK_GROUPS_LABEL} needs a model key
        </p>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          This deployment has no OpenAI key, which summaries and group names run on. Set
          OPENAI_API_KEY for the backend and the worker; it starts on its own once the key is there.
        </p>
      </div>
    );
  }

  const parts: React.ReactNode[] = [];
  if (state.status === "capped") {
    parts.push(
      <div key="capped">
        <p className="text-[13px] font-medium text-foreground">
          Today&apos;s spend cap has been reached
        </p>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          {usd(state.spentTodayUsd)} of {usd(state.dailyCostCapUsd)} spent. No new traces are
          summarized until tomorrow (UTC); groups already found keep working.
        </p>
      </div>,
    );
  }
  if (overview.fittedAt === null) {
    const pct = Math.min(100, Math.round((digestsInWindow / minDigests) * 100));
    parts.push(
      <div key="collecting">
        <p className="text-[13px] font-medium text-foreground">Not enough data yet</p>
        <p className="mt-1 max-w-2xl text-muted-foreground">
          {digestsInWindow} of {minDigests} summaries so far. Groups appear on their own once{" "}
          {minDigests} traces have been summarized (a sample of up to 300 a day).
        </p>
        <div
          className="mt-2 h-1.5 w-64 overflow-hidden rounded bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={minDigests}
          aria-valuenow={Math.min(digestsInWindow, minDigests)}
        >
          <div className="h-full bg-foreground" style={{ width: `${pct}%` }} />
        </div>
      </div>,
    );
  }
  if (parts.length === 0) return null;
  return (
    <div className={`${base} space-y-3`} role="status">
      {parts}
    </div>
  );
}
