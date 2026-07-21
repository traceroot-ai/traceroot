import { NextRequest } from "next/server";
import { prisma } from "@traceroot/core";
import { requireAuth, requireProjectAccess, successResponse } from "@/lib/auth-helpers";
import { parseScorers } from "@/lib/eval/comparison-db";

type RouteParams = { params: Promise<{ projectId: string }> };

type ValueType = "numeric" | "boolean" | "categorical" | "mixed" | "unknown";

interface Agg {
  name: string;
  version: string;
  total: number;
  errored: number;
  numericValues: number[];
  passedTrue: number;
  passedTotal: number;
  boolTrue: number;
  boolFalse: number;
  categories: Map<string, number>;
  runIds: Set<string>;
  evaluationIds: Set<string>;
  lastUsed: number; // epoch ms
  recentErrors: Array<{ message: string; at: string }>;
  seenNumeric: boolean;
  seenBool: boolean;
  seenString: boolean;
}

function inferValueType(a: Agg): ValueType {
  const kinds = [a.seenNumeric, a.seenBool, a.seenString].filter(Boolean).length;
  if (kinds > 1) return "mixed";
  if (a.seenNumeric) return "numeric";
  if (a.seenBool) return "boolean";
  if (a.seenString) return "categorical";
  return "unknown";
}

// GET — a scorer registry aggregated from the scores this project reported: per
// (name, version), the value type + declared config (direction/threshold), score
// distribution, pass/error rates with recent failures, usage across runs and
// evaluations, and when it was last used. Everything is derived from stored data —
// the SDK owns the scorer's definition; TraceRoot shows what it has observed.
export async function GET(_req: NextRequest, { params }: RouteParams) {
  const authResult = await requireAuth();
  if (authResult.error) return authResult.error;
  const { projectId } = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, projectId);
  if (accessResult.error) return accessResult.error;

  const scores = await prisma.score.findMany({
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
  });

  // Declared metadata (value_type/direction/threshold) rides in each run's scorers
  // JSON; take the most recent declaration seen for each (name, version).
  const runs = await prisma.evaluationRun.findMany({
    where: { projectId },
    select: { scorers: true },
    orderBy: { startedAt: "asc" },
  });
  const declared = new Map<
    string,
    { valueType: string | null; direction: string | null; threshold: number | null }
  >();
  for (const run of runs) {
    for (const s of parseScorers(run.scorers)) {
      if (s.valueType || s.direction || s.threshold !== null) {
        declared.set(`${s.name}@${s.version}`, {
          valueType: s.valueType ?? null,
          direction: s.direction ?? null,
          threshold: s.threshold ?? null,
        });
      }
    }
  }

  const byKey = new Map<string, Agg>();
  for (const s of scores) {
    const key = `${s.scorerName}@${s.scorerVersion}`;
    let a = byKey.get(key);
    if (!a) {
      a = {
        name: s.scorerName,
        version: s.scorerVersion,
        total: 0,
        errored: 0,
        numericValues: [],
        passedTrue: 0,
        passedTotal: 0,
        boolTrue: 0,
        boolFalse: 0,
        categories: new Map(),
        runIds: new Set(),
        evaluationIds: new Set(),
        lastUsed: 0,
        recentErrors: [],
        seenNumeric: false,
        seenBool: false,
        seenString: false,
      };
      byKey.set(key, a);
    }
    a.total += 1;
    const at = s.createTime.getTime();
    if (at > a.lastUsed) a.lastUsed = at;
    if (s.result) {
      a.runIds.add(s.result.runId);
      a.evaluationIds.add(s.result.evaluationId);
    }
    if (s.error) {
      a.errored += 1;
      a.recentErrors.push({ message: s.error, at: s.createTime.toISOString() });
    } else if (s.boolValue !== null) {
      a.seenBool = true;
      if (s.boolValue) a.boolTrue += 1;
      else a.boolFalse += 1;
    } else if (s.numericValue !== null) {
      a.seenNumeric = true;
      a.numericValues.push(s.numericValue);
    } else if (s.stringValue !== null) {
      a.seenString = true;
      a.categories.set(s.stringValue, (a.categories.get(s.stringValue) ?? 0) + 1);
    }
    if (s.passed !== null) {
      a.passedTotal += 1;
      if (s.passed) a.passedTrue += 1;
    }
  }

  const data = [...byKey.values()]
    .map((a) => {
      const valueType = inferValueType(a);
      const meta = declared.get(`${a.name}@${a.version}`) ?? null;
      const nums = a.numericValues;
      const numeric =
        nums.length > 0
          ? {
              mean: nums.reduce((x, y) => x + y, 0) / nums.length,
              min: Math.min(...nums),
              max: Math.max(...nums),
              count: nums.length,
            }
          : null;
      // Distribution: boolean → true/false; categorical → top values.
      let distribution: Array<{ label: string; count: number }> | null = null;
      if (a.seenBool && !a.seenNumeric && !a.seenString) {
        distribution = [
          { label: "true", count: a.boolTrue },
          { label: "false", count: a.boolFalse },
        ];
      } else if (a.categories.size > 0) {
        distribution = [...a.categories.entries()]
          .map(([label, count]) => ({ label, count }))
          .sort((x, y) => y.count - x.count)
          .slice(0, 8);
      }
      return {
        name: a.name,
        version: a.version,
        scoreCount: a.total,
        errorCount: a.errored,
        errorRate: a.total > 0 ? a.errored / a.total : 0,
        valueType,
        declaredValueType: meta?.valueType ?? null,
        direction: meta?.direction ?? null,
        threshold: meta?.threshold ?? null,
        numeric,
        passRate: a.passedTotal > 0 ? a.passedTrue / a.passedTotal : null,
        distribution,
        runCount: a.runIds.size,
        evaluationCount: a.evaluationIds.size,
        lastUsed: a.lastUsed > 0 ? new Date(a.lastUsed).toISOString() : null,
        recentErrors: a.recentErrors.sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 3),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

  return successResponse({ data });
}
