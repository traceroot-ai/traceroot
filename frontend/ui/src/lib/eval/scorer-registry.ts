/**
 * Pure scorer-registry aggregation. TraceRoot has no dedicated Scorer table — a
 * scorer's definition lives in the customer's SDK. The catalog is therefore DERIVED,
 * at read time, from what runs reported: the per-run `scorers` manifests (name +
 * version + optional value_type/direction/threshold) and the denormalized Score rows.
 *
 * This module is intentionally Prisma-free (like comparison-db) so it is unit-testable
 * and reusable by both the list route (all scorers) and the family/detail route (one
 * scorer, scoped). It never fabricates fields the SDK didn't report — type,
 * capabilities, prompt, code refs, scope, description and lifecycle are simply absent.
 */
import { parseScorers } from "./comparison-db";

/** Inferred value type from which value column populated (vs the SDK's *declared* type). */
export type InferredValueType = "numeric" | "boolean" | "categorical" | "mixed" | "unknown";

export interface RawScore {
  scorerName: string;
  scorerVersion: string;
  numericValue: number | null;
  boolValue: boolean | null;
  stringValue: string | null;
  passed: boolean | null;
  error: string | null;
  createTime: Date;
  runId: string | null;
  evaluationId: string | null;
}

/** The SDK-reported scorer DEFINITION (see offline-eval/sdk-ask/scorer-definition-reporting.md).
 *  Every field is optional — absent → "Not provided by SDK", never inferred/fabricated. */
export interface ScorerDefinition {
  /** Discriminator; drives the detail's top-half. */
  scorerType: "llm_judge" | "code" | null;
  outputType: "score" | "classification" | null;
  description: string | null;
  metadata: unknown | null;
  // llm_judge
  model: string | null;
  messages: Array<{ role: string; content: string }> | null;
  // code
  language: "python" | "typescript" | null;
  sourceCode: string | null;
}

function emptyDefinition(): ScorerDefinition {
  return {
    scorerType: null,
    outputType: null,
    description: null,
    metadata: null,
    model: null,
    messages: null,
    language: null,
    sourceCode: null,
  };
}

export interface ScorerRow extends ScorerDefinition {
  name: string;
  version: string;
  scoreCount: number;
  errorCount: number;
  errorRate: number;
  /** Inferred from observed values. */
  valueType: InferredValueType;
  /** Declared by the SDK manifest (may differ from inferred, or be absent). */
  declaredValueType: string | null;
  direction: string | null;
  threshold: number | null;
  numeric: { mean: number; min: number; max: number; count: number } | null;
  passRate: number | null;
  distribution: Array<{ label: string; count: number }> | null;
  runCount: number;
  evaluationCount: number;
  lastUsed: string | null;
  recentErrors: Array<{ message: string; at: string }>;
  /** Always "SDK" — the catalog only ever shows what the SDK reported. */
  source: "SDK";
}

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
  lastUsed: number;
  recentErrors: Array<{ message: string; at: string }>;
  seenNumeric: boolean;
  seenBool: boolean;
  seenString: boolean;
}

function inferValueType(a: Agg): InferredValueType {
  const kinds = [a.seenNumeric, a.seenBool, a.seenString].filter(Boolean).length;
  if (kinds > 1) return "mixed";
  if (a.seenNumeric) return "numeric";
  if (a.seenBool) return "boolean";
  if (a.seenString) return "categorical";
  return "unknown";
}

/** Most-recent declared value_type/direction/threshold per (name, version), from the
 *  ordered run manifests (later runs win). */
function declaredByKey(runManifests: Array<{ scorers: unknown }>) {
  const declared = new Map<
    string,
    { valueType: string | null; direction: string | null; threshold: number | null }
  >();
  for (const run of runManifests) {
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
  return declared;
}

/** Latest-reported scorer DEFINITION per (name, version), read from the raw manifest.
 *  A later run that reports any definition field wins (definition is part of identity;
 *  changing it should bump the scorer version). Unknown fields are ignored. */
function definitionByKey(runManifests: Array<{ scorers: unknown }>) {
  const map = new Map<string, ScorerDefinition>();
  for (const run of runManifests) {
    if (!Array.isArray(run.scorers)) continue;
    for (const raw of run.scorers) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.name !== "string") continue;
      const version = typeof o.version === "string" ? o.version : "";
      const def = emptyDefinition();
      let any = false;
      if (o.scorer_type === "llm_judge" || o.scorer_type === "code") {
        def.scorerType = o.scorer_type;
        any = true;
      }
      if (o.output_type === "score" || o.output_type === "classification") {
        def.outputType = o.output_type;
        any = true;
      }
      if (typeof o.description === "string") {
        def.description = o.description;
        any = true;
      }
      if (o.metadata !== undefined && o.metadata !== null) {
        def.metadata = o.metadata;
        any = true;
      }
      if (typeof o.model === "string") {
        def.model = o.model;
        any = true;
      }
      if (Array.isArray(o.messages)) {
        const msgs = o.messages
          .filter(
            (m): m is { role: string; content: string } =>
              !!m &&
              typeof m === "object" &&
              typeof (m as Record<string, unknown>).role === "string" &&
              typeof (m as Record<string, unknown>).content === "string",
          )
          .map((m) => ({ role: m.role, content: m.content }));
        if (msgs.length > 0) {
          def.messages = msgs;
          any = true;
        }
      }
      if (o.language === "python" || o.language === "typescript") {
        def.language = o.language;
        any = true;
      }
      if (typeof o.source === "string") {
        def.sourceCode = o.source;
        any = true;
      }
      if (any) map.set(`${o.name}@${version}`, def);
    }
  }
  return map;
}

/**
 * Aggregate raw scores + run manifests into per-(name, version) registry rows, sorted
 * by name then version. `runManifests` must be ordered oldest-first so the newest
 * declaration wins.
 */
export function aggregateScorers(
  scores: RawScore[],
  runManifests: Array<{ scorers: unknown }>,
): ScorerRow[] {
  const declared = declaredByKey(runManifests);
  const definitions = definitionByKey(runManifests);
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
    if (s.runId) a.runIds.add(s.runId);
    if (s.evaluationId) a.evaluationIds.add(s.evaluationId);
    if (s.error) {
      // A scorer error contributes to error stats but is never a 0 score.
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

  return [...byKey.values()]
    .map((a): ScorerRow => {
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
        ...(definitions.get(`${a.name}@${a.version}`) ?? emptyDefinition()),
        name: a.name,
        version: a.version,
        scoreCount: a.total,
        errorCount: a.errored,
        errorRate: a.total > 0 ? a.errored / a.total : 0,
        valueType: inferValueType(a),
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
        source: "SDK",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}
