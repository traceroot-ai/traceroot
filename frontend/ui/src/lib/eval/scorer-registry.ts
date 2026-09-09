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

/** The SDK-reported scorer DEFINITION.
 *  Every field is optional — absent → "Not provided by SDK", never inferred/fabricated. */
export interface ScorerDefinition {
  /** Discriminator; drives the detail's top-half. */
  scorerType: "llm_judge" | "code" | null;
  outputType: "score" | "classification" | null;
  description: string | null;
  /** The inputs the scorer reads (e.g. "input", "output", "expected"). Drives the
   *  "Requires" card and the reference-answer used/not-used note. Null = the SDK
   *  never declared them (unknown), which is NOT the same as "reads nothing". */
  requiredInputs: string[] | null;
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
    requiredInputs: null,
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
  /** Stable SEMANTIC identity across SDK languages — the manifest's `key`, or the `name`
   *  when the SDK didn't send one. Lets the UI group a Python `covers_both_cities` and a
   *  TypeScript `coversBothCities` (same `key`) as one logical scorer while each row keeps
   *  its own `name`/`language` provenance. Never derived from `source`/code hash. */
  key: string;
  /** Rows that actually produced a value (excludes errored attempts). */
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
  /** Fingerprint of the latest-reported definition (null when no definition was ever
   *  reported). Lets the UI tell whether `distinctDefinitions` above 1 means this
   *  exact definition, or one since superseded, is what the aggregates reflect. */
  definitionHash: string | null;
  /** How many distinct definition fingerprints were reported under this identical
   *  (name, version) key. >1 means the pooled aggregates below span genuinely
   *  different measurement instruments (see module docs on identity). */
  distinctDefinitions: number;
}

interface Agg {
  name: string;
  version: string;
  total: number;
  errored: number;
  numSum: number;
  numMin: number;
  numMax: number;
  numCount: number;
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

function newAgg(name: string, version: string): Agg {
  return {
    name,
    version,
    total: 0,
    errored: 0,
    numSum: 0,
    numMin: Infinity,
    numMax: -Infinity,
    numCount: 0,
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

/** Cheap, non-cryptographic fingerprint of a definition payload — good enough to
 *  detect "two manifests disagree", not to dedupe against an adversary. */
function hashDefinition(def: ScorerDefinition): string {
  const payload = JSON.stringify([
    def.scorerType,
    def.outputType,
    def.model,
    def.messages,
    def.language,
    def.sourceCode,
    def.requiredInputs,
  ]);
  let h = 0;
  for (let i = 0; i < payload.length; i++) {
    h = (Math.imul(h, 31) + payload.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

/** Latest-reported scorer DEFINITION per (name, version), read from the raw manifest,
 *  plus every distinct definition fingerprint observed under that key. A later run
 *  that reports any definition field wins for the returned definition (definition is
 *  part of identity; changing it should bump the scorer version) — but `hashesByKey`
 *  still records when more than one distinct definition was reported under the same
 *  key, so callers can flag that the pooled aggregates span more than one instrument.
 *  Unknown fields are ignored. */
function definitionByKey(runManifests: Array<{ scorers: unknown }>): {
  map: Map<string, ScorerDefinition>;
  hashesByKey: Map<string, Set<string>>;
} {
  const map = new Map<string, ScorerDefinition>();
  const hashesByKey = new Map<string, Set<string>>();
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
      if (Array.isArray(o.required_inputs)) {
        const inputs = o.required_inputs.filter((x): x is string => typeof x === "string");
        // An explicit empty array is a real answer ("reads nothing"), distinct from
        // an absent field — so [] is kept, not coalesced back to null.
        def.requiredInputs = inputs;
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
      if (any) {
        const key = `${o.name}@${version}`;
        map.set(key, def);
        let hashes = hashesByKey.get(key);
        if (!hashes) {
          hashes = new Set();
          hashesByKey.set(key, hashes);
        }
        hashes.add(hashDefinition(def));
      }
    }
  }
  return { map, hashesByKey };
}

/** Every (name, version) pair any run manifest referenced, regardless of whether it
 *  carried rich fields — used to seed a catalog row for a scorer that has been
 *  declared but never yet scored (or a version whose first result hasn't landed). */
function allManifestKeys(
  runManifests: Array<{ scorers: unknown }>,
): Map<string, { name: string; version: string }> {
  const keys = new Map<string, { name: string; version: string }>();
  for (const run of runManifests) {
    for (const s of parseScorers(run.scorers)) {
      keys.set(`${s.name}@${s.version}`, { name: s.name, version: s.version });
    }
  }
  return keys;
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
  const { map: definitions, hashesByKey } = definitionByKey(runManifests);
  // The manifest's stable semantic key per (name, version), defaulting to the name when the
  // SDK omitted it. Exposed on every row so the UI can group cross-language implementations
  // (same key) without the platform merging away their distinct name/language provenance.
  const semanticKeyByRow = new Map<string, string>();
  for (const run of runManifests) {
    if (!Array.isArray(run.scorers)) continue;
    for (const raw of run.scorers) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.name !== "string") continue;
      const version = typeof o.version === "string" ? o.version : "";
      semanticKeyByRow.set(
        `${o.name}@${version}`,
        typeof o.key === "string" && o.key ? o.key : o.name,
      );
    }
  }
  const byKey = new Map<string, Agg>();

  for (const s of scores) {
    const key = `${s.scorerName}@${s.scorerVersion}`;
    let a = byKey.get(key);
    if (!a) {
      a = newAgg(s.scorerName, s.scorerVersion);
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
      a.numCount += 1;
      a.numSum += s.numericValue;
      if (s.numericValue < a.numMin) a.numMin = s.numericValue;
      if (s.numericValue > a.numMax) a.numMax = s.numericValue;
    } else if (s.stringValue !== null) {
      a.seenString = true;
      a.categories.set(s.stringValue, (a.categories.get(s.stringValue) ?? 0) + 1);
    }
    if (s.passed !== null) {
      a.passedTotal += 1;
      if (s.passed) a.passedTrue += 1;
    }
  }

  // Seed a zero-count row for every (name, version) a manifest declared but that
  // never produced a Score row — a version declared and not yet scored (or whose
  // first result hasn't landed) should still resolve.
  for (const [key, { name, version }] of allManifestKeys(runManifests)) {
    if (!byKey.has(key)) byKey.set(key, newAgg(name, version));
  }

  return [...byKey.values()]
    .map((a): ScorerRow => {
      const key = `${a.name}@${a.version}`;
      const meta = declared.get(key) ?? null;
      const numeric =
        a.numCount > 0
          ? { mean: a.numSum / a.numCount, min: a.numMin, max: a.numMax, count: a.numCount }
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
      const definition = definitions.get(key) ?? null;
      const hashes = hashesByKey.get(key);
      return {
        ...(definition ?? emptyDefinition()),
        name: a.name,
        version: a.version,
        // Semantic identity from the manifest (key ?? name); a score-only metric row that
        // no manifest declared keeps its own name as the key.
        key: semanticKeyByRow.get(key) ?? a.name,
        // Rows that actually produced a value — an all-errored scorer reports 0,
        // never `total`, so it doesn't read as having "scored" anything.
        scoreCount: a.total - a.errored,
        errorCount: a.errored,
        errorRate: a.total > 0 ? a.errored / a.total : 0,
        valueType: inferValueType(a),
        declaredValueType: meta?.valueType ?? null,
        direction: meta?.direction ?? null,
        threshold: meta?.threshold ?? null,
        numeric,
        passRate: a.passedTotal > 0 ? a.passedTrue / a.passedTotal : null,
        distribution,
        definitionHash: definition ? hashDefinition(definition) : null,
        distinctDefinitions: hashes?.size ?? 0,
        runCount: a.runIds.size,
        evaluationCount: a.evaluationIds.size,
        lastUsed: a.lastUsed > 0 ? new Date(a.lastUsed).toISOString() : null,
        recentErrors: a.recentErrors.sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 3),
        source: "SDK",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}
