"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PendingDecision, PendingDecisionAction } from "../hooks/use-ai-chat";

/**
 * The composer's approval bar for a write the agent has parked: one question
 * naming the proposed resource, a create and a skip button, and the reminder
 * that a typed reply revises. It sits directly above the input because the
 * decision IS the reply — the card in the thread only shows what would be
 * created.
 *
 * `onDecide` resolves true when the decision settled (posted, or already
 * resolved elsewhere): the buttons stay disabled and the stream replaces the
 * bar. False means the request never landed, and the buttons come back.
 */
export function PendingDecisionBar({
  decision,
  onDecide,
}: {
  decision: PendingDecision;
  onDecide: (params: {
    toolCallId: string;
    decisionId: string;
    action: PendingDecisionAction;
  }) => Promise<boolean>;
}) {
  const [inFlight, setInFlight] = useState<PendingDecisionAction | null>(null);

  const decide = async (action: PendingDecisionAction) => {
    if (inFlight !== null) return;
    setInFlight(action);
    const settled = await onDecide({
      toolCallId: decision.toolCallId,
      decisionId: decision.decisionId,
      action,
    }).catch(() => false);
    if (!settled) setInFlight(null);
  };

  const spinner = <Loader2 className="h-3 w-3 animate-spin" />;

  return (
    <div className="mx-3 mb-1 rounded-md border border-border bg-card px-2.5 py-2 text-xs">
      <p className="truncate font-medium text-foreground">
        Create {decision.resourceType}
        {decision.title !== null && (
          <>
            {" "}
            <span className="font-normal text-muted-foreground">{decision.title}</span>
          </>
        )}
        ?
      </p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Button
          size="sm"
          className="h-6 gap-1.5 px-2.5 text-[11px]"
          disabled={inFlight !== null}
          onClick={() => void decide("create")}
        >
          {inFlight === "create" && spinner}
          Create {decision.resourceType}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 px-2.5 text-[11px] text-muted-foreground"
          disabled={inFlight !== null}
          onClick={() => void decide("skip")}
        >
          {inFlight === "skip" && spinner}
          Skip
        </Button>
        <span className="ml-auto min-w-0 truncate text-[11px] text-muted-foreground/70">
          or reply below to revise
        </span>
      </div>
    </div>
  );
}
