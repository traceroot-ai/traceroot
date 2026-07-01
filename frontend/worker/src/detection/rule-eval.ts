/**
 * Deterministic rule-based detector evaluation.
 *
 * Unlike `sandbox-eval.ts` (LLM-as-a-judge), this module never calls a model.
 * It evaluates a small, declarative condition DSL against each span of a
 * trace and reports a match the moment any span satisfies it. This is the
 * "rule" / "code" detector type from issue #1386 — e.g. a zero-cost,
 * 100%-reproducible "Missing Data" detector that flags empty/null
 * input or output on observations.
 *
 * We intentionally do NOT execute arbitrary user-authored JS/Python here.
 * Running untrusted code in the worker process without a real sandbox
 * (vm2/isolated-vm/gVisor, etc.) is a code-execution security hole, and this
 * worker has no such sandbox today. A declarative condition list gives users
 * the same practical expressiveness for schema/data-quality checks (the
 * issue's primary motivating use case) without that risk. True arbitrary-code
 * execution can be layered in later behind a real sandboxed runner using the
 * same `RuleConfig`/`EvalResult` contract.
 */

export type RuleOp =
  | "is_empty" // "", null, undefined, or (after JSON.stringify) "{}" / "[]"
  | "is_missing" // field path does not resolve to anything (undefined)
  | "exists" // field path resolves to a defined, non-null value
  | "equals"
  | "not_equals"
  | "contains" // substring match (string fields) / array membership
  | "greater_than"
  | "less_than";

export interface RuleCondition {
  /** Dot path into the span object, e.g. "input", "output", "attributes.tokens". */
  field: string;
  op: RuleOp;
  /** Required for equals/not_equals/contains/greater_than/less_than. */
  value?: unknown;
}

export interface RuleConfig {
  conditions: RuleCondition[];
  /** "any" (OR, default) or "all" (AND) across `conditions`, evaluated per span. */
  match?: "any" | "all";
}

export interface RuleEvalResult {
  identified: boolean;
  summary: string;
  data: Record<string, unknown>;
  error?: string;
}

/** Resolve a dot path ("attributes.tokens") against a plain object. */
function resolvePath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

function evalCondition(span: unknown, cond: RuleCondition): boolean {
  const actual = resolvePath(span, cond.field);
  switch (cond.op) {
    case "is_empty":
      return isEmptyValue(actual);
    case "is_missing":
      return actual === undefined;
    case "exists":
      return actual !== undefined && actual !== null;
    case "equals":
      return actual === cond.value;
    case "not_equals":
      return actual !== cond.value;
    case "contains":
      if (typeof actual === "string" && typeof cond.value === "string") {
        return actual.includes(cond.value);
      }
      if (Array.isArray(actual)) return actual.includes(cond.value);
      return false;
    case "greater_than":
      return typeof actual === "number" && typeof cond.value === "number" && actual > cond.value;
    case "less_than":
      return typeof actual === "number" && typeof cond.value === "number" && actual < cond.value;
    default:
      return false;
  }
}

function evalSpan(span: unknown, conditions: RuleCondition[], match: "any" | "all"): boolean {
  if (conditions.length === 0) return false;
  return match === "all"
    ? conditions.every((c) => evalCondition(span, c))
    : conditions.some((c) => evalCondition(span, c));
}

function describeCondition(c: RuleCondition): string {
  switch (c.op) {
    case "is_empty":
      return `${c.field} is empty`;
    case "is_missing":
      return `${c.field} is missing`;
    case "exists":
      return `${c.field} exists`;
    default:
      return `${c.field} ${c.op} ${JSON.stringify(c.value)}`;
  }
}

/** Parse one JSON object per line; malformed lines are skipped, not fatal. */
function parseSpansJsonl(spansJsonl: string): Array<Record<string, unknown>> {
  const spans: Array<Record<string, unknown>> = [];
  for (const line of spansJsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") spans.push(parsed as Record<string, unknown>);
    } catch {
      // skip malformed line — deterministic checks should not fail the whole
      // trace over one bad line; the rest of the trace is still evaluated.
    }
  }
  return spans;
}

/**
 * Evaluate a rule-based detector against a trace's spans. Pure and
 * synchronous — no network/model calls, so callers attribute zero inference
 * cost/tokens for this evaluation.
 */
export function evaluateRuleDetector(params: {
  spansJsonl: string;
  ruleConfig: RuleConfig | null | undefined;
}): RuleEvalResult {
  const { spansJsonl, ruleConfig } = params;

  if (!ruleConfig || !Array.isArray(ruleConfig.conditions) || ruleConfig.conditions.length === 0) {
    return {
      identified: false,
      summary: "Rule detector has no conditions configured",
      data: {},
      error: "empty ruleConfig.conditions",
    };
  }

  const match = ruleConfig.match === "all" ? "all" : "any";
  const spans = parseSpansJsonl(spansJsonl);

  for (const span of spans) {
    if (evalSpan(span, ruleConfig.conditions, match)) {
      const matchedDescriptions = ruleConfig.conditions
        .filter((c) => evalCondition(span, c))
        .map(describeCondition);
      const spanId =
        (span.span_id as string | undefined) ?? (span.id as string | undefined) ?? "unknown";
      return {
        identified: true,
        summary: `Span ${spanId}: ${matchedDescriptions.join(", ")}`,
        data: {
          spanId,
          matchedConditions: matchedDescriptions,
        },
      };
    }
  }

  return {
    identified: false,
    summary: `No span matched (${match.toUpperCase()} of ${ruleConfig.conditions.length} condition(s))`,
    data: {},
  };
}