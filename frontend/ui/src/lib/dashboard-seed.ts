// The per-project "Default" dashboard: seeded at project creation (both the
// UI route and the write service), with the dashboards list's lazy seed kept
// as backfill for projects that predate creation-time seeding. Once created
// it is fully user-owned — never re-seeded or force-updated.

import type { Prisma } from "@prisma/client";
import type { WidgetType } from "@/features/dashboards/types";

type SeedWidget = {
  title: string;
  type: WidgetType;
  spec: object;
  layout: { x: number; y: number; w: number; h: number };
};

export function defaultDashboardId(projectId: string): string {
  // Deterministic id makes lazy creation idempotent across concurrent requests
  // (second insert fails the PK constraint and is swallowed).
  return `default_${projectId}`;
}

export function seedWidgets(): SeedWidget[] {
  const stat = (title: string, spec: object, x: number): SeedWidget => ({
    title,
    type: "query",
    spec,
    layout: { x, y: 0, w: 3, h: 2 },
  });

  const widgets: SeedWidget[] = [
    stat(
      "Trace count",
      {
        view: "traces",
        filters: [],
        metric: { measure: "count", agg: "count" },
        breakdown: null,
        display: { type: "number" },
      },
      0,
    ),
    stat(
      "Total cost",
      {
        view: "traces",
        filters: [],
        metric: { measure: "cost", agg: "sum" },
        breakdown: null,
        display: { type: "number" },
      },
      3,
    ),
    stat(
      "Tokens",
      {
        view: "traces",
        filters: [],
        metric: { measure: "total_tokens", agg: "sum" },
        breakdown: null,
        display: { type: "number" },
      },
      6,
    ),
    stat(
      "p95 latency",
      {
        view: "traces",
        filters: [],
        metric: { measure: "duration_ms", agg: "p95" },
        breakdown: null,
        display: { type: "number" },
      },
      9,
    ),
    {
      title: "Cost over time · by model",
      type: "query",
      spec: {
        view: "spans",
        filters: [{ field: "span_kind", op: "=", value: "LLM" }],
        metric: { measure: "cost", agg: "sum" },
        breakdown: "model_name",
        display: { type: "line" },
      },
      layout: { x: 0, y: 2, w: 8, h: 6 },
    },
    {
      title: "Tokens by model",
      type: "query",
      spec: {
        view: "spans",
        filters: [{ field: "span_kind", op: "=", value: "LLM" }],
        metric: { measure: "total_tokens", agg: "sum" },
        breakdown: "model_name",
        display: { type: "bar" },
      },
      layout: { x: 8, y: 2, w: 4, h: 6 },
    },
    {
      title: "Recent traces",
      type: "trace_feed",
      spec: { filters: [], limit: 10 },
      layout: { x: 0, y: 8, w: 6, h: 4 },
    },
    {
      title: "Recent failures",
      type: "trace_feed",
      // Trace-list predicate wire format: only traces that recorded errors.
      spec: { filters: [{ field: "errors", op: "gt", value: 0 }], limit: 10 },
      layout: { x: 6, y: 8, w: 6, h: 4 },
    },
  ];

  return widgets;
}

/**
 * Create the "Default" dashboard and its starter widgets for a project.
 *
 * Accepts a transaction client so creation-time seeding commits atomically
 * with the project row; the deterministic dashboard id keeps the lazy backfill
 * idempotent (a concurrent duplicate fails the PK constraint, which that call
 * site swallows). This function itself does not swallow — inside a
 * project-create transaction a clash is a real error.
 */
export async function seedDefaultDashboard(
  tx: Pick<Prisma.TransactionClient, "dashboard">,
  { projectId, actorUserId }: { projectId: string; actorUserId: string },
): Promise<void> {
  const seeded = seedWidgets().map((w, i) => ({ ...w, id: `seed-${i}-${projectId}` }));
  await tx.dashboard.create({
    data: {
      id: defaultDashboardId(projectId),
      projectId,
      name: "Default",
      description: "Auto-created overview of traces, cost, tokens, and latency.",
      isDefault: true,
      createdBy: actorUserId,
      // layout keys MUST equal widget ids (react-grid-layout matches on `i`)
      layout: seeded.map((w) => ({ i: w.id, ...w.layout })),
      widgets: {
        create: seeded.map((w) => ({ id: w.id, title: w.title, type: w.type, spec: w.spec })),
      },
    },
  });
}
