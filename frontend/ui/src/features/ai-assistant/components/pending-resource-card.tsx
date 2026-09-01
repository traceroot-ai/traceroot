"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResourceCard } from "./resource-card";
import type { ResourceCardModel } from "../lib/resource-card";

export type PendingDecisionAction = "create" | "skip";

/**
 * The Phase 1 card for a write the agent has proposed but not run, shown
 * BEFORE the resource exists. Its only affordances are the two buttons — they
 * ARE the pending signal, so there is no status badge and nothing else to
 * click (revision goes through the chat box).
 *
 * `onDecide` resolves true when the decision settled (posted, or already
 * resolved elsewhere): the buttons stay disabled and the stream replaces the
 * card. False means the request never landed, and the buttons come back.
 */
export function PendingResourceCard({
  model,
  onDecide,
}: {
  model: ResourceCardModel;
  onDecide: (action: PendingDecisionAction) => Promise<boolean>;
}) {
  const [inFlight, setInFlight] = useState<PendingDecisionAction | null>(null);

  const decide = async (action: PendingDecisionAction) => {
    if (inFlight !== null) return;
    setInFlight(action);
    const settled = await onDecide(action).catch(() => false);
    if (!settled) setInFlight(null);
  };

  const spinner = <Loader2 className="h-3 w-3 animate-spin" />;

  return (
    <ResourceCard
      model={model}
      footer={
        <div className="flex items-center gap-1.5 pt-0.5">
          <Button
            size="sm"
            className="h-6 gap-1.5 px-2.5 text-[11px]"
            disabled={inFlight !== null}
            onClick={() => void decide("create")}
          >
            {inFlight === "create" && spinner}
            Create {model.resourceType}
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
        </div>
      }
    />
  );
}
