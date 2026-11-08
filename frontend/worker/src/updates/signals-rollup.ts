import type { PrismaClient } from "@traceroot/core";
import type { UpdateWindows } from "@traceroot/core/updates";

/**
 * The signals section of an update: which signals are new, resolved or
 * spiking in the window, with counts against the window before and a link.
 * It is read straight from the signal tables and is not explained again here;
 * a signal already has its own summary.
 */

export interface RollupSignal {
  id: string;
  title: string;
  hitsInWindow: number;
  hitsInPreviousWindow: number;
  link: string;
}

export interface SignalsRollup {
  new: RollupSignal[];
  resolved: RollupSignal[];
  spiking: RollupSignal[];
}

/** A spike needs real volume as well as a multiple; tuned later on real projects. */
export const SPIKE_RULES = { minHits: 10, minMultiple: 2, minIncrease: 5 };

type RollupDb = Pick<PrismaClient, "signal" | "signalHit" | "signalStatusEvent">;

export function signalLink(appBaseUrl: string, projectId: string, signalId: string): string {
  return `${appBaseUrl}/projects/${encodeURIComponent(projectId)}/signals?signalId=${encodeURIComponent(signalId)}`;
}

export async function buildSignalsRollup(
  db: RollupDb,
  projectId: string,
  windows: Pick<UpdateWindows, "windowStart" | "windowEnd" | "prevWindowStart" | "prevWindowEnd">,
  appBaseUrl: string,
): Promise<SignalsRollup> {
  const hitCounts = async (from: Date, to: Date) => {
    const rows = await db.signalHit.groupBy({
      by: ["signalId"],
      where: { projectId, seenAt: { gte: from, lt: to } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.signalId, r._count._all]));
  };
  const [current, previous] = await Promise.all([
    hitCounts(windows.windowStart, windows.windowEnd),
    hitCounts(windows.prevWindowStart, windows.prevWindowEnd),
  ]);

  const live = { projectId, mergedIntoId: null, status: { not: "dismissed" } };
  const [newOnes, resolvedEvents] = await Promise.all([
    db.signal.findMany({
      where: { ...live, firstSeenAt: { gte: windows.windowStart, lt: windows.windowEnd } },
      select: { id: true, title: true },
      orderBy: { id: "asc" },
    }),
    db.signalStatusEvent.findMany({
      where: {
        toStatus: "resolved",
        createTime: { gte: windows.windowStart, lt: windows.windowEnd },
        signal: { projectId, mergedIntoId: null },
      },
      select: { signalId: true, signal: { select: { title: true } } },
      orderBy: { signalId: "asc" },
    }),
  ]);
  const newIds = new Set(newOnes.map((s) => s.id));

  const entry = (id: string, title: string): RollupSignal => ({
    id,
    title,
    hitsInWindow: current.get(id) ?? 0,
    hitsInPreviousWindow: previous.get(id) ?? 0,
    link: signalLink(appBaseUrl, projectId, id),
  });

  const spikeIds = [...current.entries()]
    .filter(([id, now]) => {
      const before = previous.get(id) ?? 0;
      return (
        !newIds.has(id) &&
        now >= SPIKE_RULES.minHits &&
        now >= SPIKE_RULES.minMultiple * before &&
        now - before >= SPIKE_RULES.minIncrease
      );
    })
    .map(([id]) => id);
  const spikeRows = spikeIds.length
    ? await db.signal.findMany({
        where: { ...live, id: { in: spikeIds } },
        select: { id: true, title: true },
        orderBy: { id: "asc" },
      })
    : [];

  const resolvedSeen = new Set<string>();
  const resolved: RollupSignal[] = [];
  for (const event of resolvedEvents) {
    if (resolvedSeen.has(event.signalId)) continue;
    resolvedSeen.add(event.signalId);
    resolved.push(entry(event.signalId, event.signal.title));
  }

  return {
    new: newOnes.map((s) => entry(s.id, s.title)),
    resolved,
    spiking: spikeRows.map((s) => entry(s.id, s.title)),
  };
}
