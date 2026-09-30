import { describe, it, expect, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import { WidgetSpecSchema } from "@/features/dashboards/types";
import { parseTraceFeedSpec } from "@/features/dashboards/trace-feed-spec";
import { defaultDashboardId, seedDefaultDashboard, seedWidgets } from "./dashboard-seed";

describe("seedWidgets", () => {
  it("every starter spec satisfies the canonical validation its type is stored under", () => {
    for (const w of seedWidgets()) {
      if (w.type === "query") {
        const parsed = WidgetSpecSchema.safeParse(w.spec);
        expect(parsed.success, `query spec for "${w.title}" must validate`).toBe(true);
        // The stored spec must already be in parsed form (defaults filled),
        // so what the seed writes is exactly what the renderer reads.
        expect(parsed.data).toEqual(w.spec);
      } else {
        const parsed = parseTraceFeedSpec(w.spec as Record<string, unknown>);
        expect(parsed.ok, `trace_feed spec for "${w.title}" must validate`).toBe(true);
        if (parsed.ok) expect(parsed.data).toEqual(w.spec);
      }
    }
  });
});

describe("seedDefaultDashboard", () => {
  it("creates the Default dashboard with deterministic ids and the starter widgets", async () => {
    const create = vi.fn().mockResolvedValue({});
    const tx = { dashboard: { create } } as unknown as Pick<Prisma.TransactionClient, "dashboard">;

    await seedDefaultDashboard(tx, { projectId: "p1", actorUserId: "u9" });

    expect(create).toHaveBeenCalledTimes(1);
    const { data } = create.mock.calls[0][0];
    const widgets = seedWidgets();
    const seeded = widgets.map((w, i) => ({ ...w, id: `seed-${i}-p1` }));
    expect(data).toEqual({
      id: defaultDashboardId("p1"),
      projectId: "p1",
      name: "Default",
      description: "Auto-created overview of traces, cost, tokens, and latency.",
      isDefault: true,
      createdBy: "u9",
      layout: seeded.map((w) => ({ i: w.id, ...w.layout })),
      widgets: {
        create: seeded.map((w) => ({ id: w.id, title: w.title, type: w.type, spec: w.spec })),
      },
    });
    // react-grid-layout matches layout entries to widgets on `i`.
    expect(data.layout.map((l: { i: string }) => l.i)).toEqual(
      data.widgets.create.map((w: { id: string }) => w.id),
    );
  });
});
