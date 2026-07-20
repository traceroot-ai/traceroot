import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { aggregateScorers, type RawScore } from "@/lib/eval/scorer-registry";

type RouteParams = { params: Promise<{ projectId: string }> };

// GET — the scorer catalog, aggregated (no N+1) from what runs reported: per
// (name, version), the value type + declared config (direction/threshold), score
// distribution, pass/error rates with recent failures, usage across runs and
// evaluations, and when it was last used. Everything is DERIVED from stored data —
// the SDK owns the scorer's definition; TraceRoot shows only what it has observed.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const [scores, runs] = await Promise.all([
    prisma.score.findMany({
      where: { projectId },
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
    prisma.evaluationRun.findMany({
      where: { projectId },
      select: { scorers: true },
      orderBy: { startedAt: "asc" },
    }),
  ]);

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

  return successResponse({ data: aggregateScorers(raw, runs) });
}
