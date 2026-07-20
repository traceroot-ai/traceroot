import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import {
  requireAuth,
  requireProjectAccess,
  errorResponse,
  successResponse,
} from "@/lib/auth-helpers";
import { aggregateScorers, type RawScore, type ScorerRow } from "@/lib/eval/scorer-registry";

type RouteParams = { params: Promise<{ projectId: string; name: string }> };

// GET — one scorer FAMILY (all versions of a scorer name) with per-version aggregates
// and a family-level usage/recent-run summary. Scoped to the scorer name so it reads
// only that scorer's Score rows (not the whole project), still with no N+1. Read-only:
// scorers are defined in the SDK and cannot be created or edited here.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId, name: rawName } = await params;
  const name = decodeURIComponent(rawName);
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const [scores, runs] = await Promise.all([
    prisma.score.findMany({
      where: { projectId, scorerName: name },
      select: {
        scorerName: true,
        scorerVersion: true,
        numericValue: true,
        boolValue: true,
        stringValue: true,
        passed: true,
        error: true,
        createTime: true,
        result: { select: { runId: true, evaluationId: true } },
      },
    }),
    // The manifests carry declared config; the whole project's runs are scanned (a
    // small JSON-only query) so a version declared but not yet scored still resolves.
    prisma.evaluationRun.findMany({
      where: { projectId },
      select: { scorers: true },
      orderBy: { startedAt: "asc" },
    }),
  ]);

  if (scores.length === 0) return errorResponse("Scorer not found", 404);

  const raw: RawScore[] = scores.map((s) => ({
    scorerName: s.scorerName,
    scorerVersion: s.scorerVersion,
    numericValue: s.numericValue,
    boolValue: s.boolValue,
    stringValue: s.stringValue,
    passed: s.passed,
    error: s.error,
    createTime: s.createTime,
    runId: s.result?.runId ?? null,
    evaluationId: s.result?.evaluationId ?? null,
  }));

  // Only this family's versions (aggregateScorers may also see the name via manifests).
  const versions: ScorerRow[] = aggregateScorers(raw, runs).filter((r) => r.name === name);

  // Family-level union: distinct runs/evaluations, totals, latest use across versions.
  const runIds = new Set<string>();
  const evaluationIds = new Set<string>();
  let lastUsed: string | null = null;
  let scoreCount = 0;
  let errorCount = 0;
  for (const r of raw) {
    if (r.runId) runIds.add(r.runId);
    if (r.evaluationId) evaluationIds.add(r.evaluationId);
    const at = r.createTime.toISOString();
    if (!lastUsed || at > lastUsed) lastUsed = at;
    scoreCount += 1;
    if (r.error) errorCount += 1;
  }

  return successResponse({
    name,
    versions,
    usage: {
      runCount: runIds.size,
      evaluationCount: evaluationIds.size,
      scoreCount,
      errorCount,
      lastUsed,
    },
    source: "SDK" as const,
  });
}
