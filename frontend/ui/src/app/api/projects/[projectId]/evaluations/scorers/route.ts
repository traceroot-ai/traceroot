import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET — read-only scorer registry, aggregated from the scores reported on this
// project's runs: distinct (name, version) with usage count and error rate.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const scores = await prisma.score.findMany({
    where: { projectId },
    select: { scorerName: true, scorerVersion: true, error: true },
  });

  const byKey = new Map<
    string,
    { name: string; version: string; total: number; errored: number }
  >();
  for (const s of scores) {
    const key = `${s.scorerName}@${s.scorerVersion}`;
    const entry = byKey.get(key) ?? {
      name: s.scorerName,
      version: s.scorerVersion,
      total: 0,
      errored: 0,
    };
    entry.total += 1;
    if (s.error) entry.errored += 1;
    byKey.set(key, entry);
  }

  const data = [...byKey.values()]
    .map((e) => ({
      name: e.name,
      version: e.version,
      scoreCount: e.total,
      errorCount: e.errored,
      errorRate: e.total > 0 ? e.errored / e.total : 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  return successResponse({ data });
}
