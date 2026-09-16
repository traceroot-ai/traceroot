"use client";

import { ResourceCard } from "./resource-card";
import type { ResourceCardModel } from "../lib/resource-card";

/**
 * The card for a write the agent has proposed but not run, shown BEFORE the
 * resource exists. It is the receipt's twin — same body, same footer — marked
 * proposed so a parked card reads as one, and with nothing to open, because
 * there is no page yet. It offers no decision: create/skip lives in the
 * composer's approval bar, and a typed reply revises.
 */
export function PendingResourceCard({ model }: { model: ResourceCardModel }) {
  return <ResourceCard model={model} proposed />;
}
