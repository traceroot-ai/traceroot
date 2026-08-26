import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { aggregateScorers, type RawScore } from "@/lib/eval/scorer-registry";

type RouteParams = { params: Promise<{ projectId: string }> };

// Score cardinality is runs x test cases x scorers and only ever grows, so an
// unbounded findMany here is a memory/latency cliff that scales with a project's
// lifetime, not its current size. Until this is pushed into
// a SQL GROUP BY, bound the read: take the most recent MAX_SCORE_ROWS and say so in
// the response so the UI can label the aggregates as windowed instead of silently
// dropping older activity.
const MAX_SCORE_ROWS = 50_000;
// Same shape of problem on the manifest side — ScorerRefSchema allows a full judge
// prompt/source per scorer per run, so scanning every run in the project's history
// can pull megabytes of duplicated text just to resolve latest-wins definitions.
// The newest MAX_MANIFEST_RUNS is enough for any currently-active scorer to resolve.
const MAX_MANIFEST_RUNS = 2_000;

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

  const [scores, runsDesc] = await Promise.all([
    prisma.score.findMany({
      where: { projectId },
      orderBy: { createTime: "desc" },
      take: MAX_SCORE_ROWS,
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
      orderBy: { startedAt: "desc" },
      take: MAX_MANIFEST_RUNS,
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

  // aggregateScorers requires runManifests oldest-first so the newest declaration wins.
  const runs = [...runsDesc].reverse();

  return successResponse({
    data: aggregateScorers(raw, runs),
    meta: {
      // True when either read hit its cap — the aggregates above are then a window
      // over recent activity, not the whole project's history.
      windowed: scores.length === MAX_SCORE_ROWS || runsDesc.length === MAX_MANIFEST_RUNS,
    },
  });
}
