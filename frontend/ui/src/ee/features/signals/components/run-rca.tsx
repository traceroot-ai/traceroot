"use client";

import { useDemoAgentAccess } from "@/features/ai-assistant/hooks/use-demo-agent-access";
import { Button } from "@/components/ui/button";
import { rcaInProgress, useRequestSignalRca } from "../hooks";
import { useT } from "@/lib/i18n/provider";

/**
 * A signal without an analysis: run it by hand (its detector's RCA is Manual,
 * or the last attempt failed), or see that it is running.
 */
export function RunRca({
  projectId,
  signalId,
  state,
  available,
  showState = true,
}: {
  projectId: string;
  signalId: string;
  /** The current opening's analysis state; null when none was asked for. */
  state: string | null;
  /** False when the deployment runs no signal RCA (it has no OpenAI API key). */
  available: boolean;
  /** False when the caller already says whether it failed or is running (until a new request starts). */
  showState?: boolean;
}) {
  const { readOnly, loading } = useDemoAgentAccess(projectId);
  const request = useRequestSignalRca(projectId, signalId);
  const t = useT();
  if (loading) return null;
  if (!available) {
    return <p className="text-[12px] text-muted-foreground">{t("eeRunRca.unavailable")}</p>;
  }
  const running = rcaInProgress(state) || request.isPending;
  return (
    <div className="space-y-3" aria-live="polite">
      {request.isError && (
        <p role="alert" className="text-[12px] text-destructive">
          {t("eeRunRca.startFailed")}
        </p>
      )}
      {/* A request just sent outruns the caller's state: say it is running. */}
      {(showState || request.isPending) &&
        (running ? (
          <p className="text-[12px] text-muted-foreground">{t("eeRunRca.analyzing")}</p>
        ) : (
          state === "failed" && (
            <p className="text-[12px] text-muted-foreground">{t("eeRunRca.lastFailed")}</p>
          )
        ))}
      {/* A demo visitor still sees the state above, but cannot start a run. */}
      {readOnly ? (
        <p className="text-[12px] text-muted-foreground">{t("eeRunRca.demoReadOnly")}</p>
      ) : (
        <Button
          size="sm"
          className="h-7 text-[12px]"
          disabled={running}
          onClick={() => request.mutate()}
        >
          {running ? t("eeRunRca.running") : t("eeRunRca.run")}
        </Button>
      )}
    </div>
  );
}
