/**
 * Trace-derived token/cost attribution for an evaluation trace.
 *
 * An evaluation trace is shaped:
 *
 *   evaluation-item (EVALUATION, root)
 *   ├── task (TASK)            ← the candidate application; app/LLM/tool spans nest here
 *   │   └── … LLM leaf(s)      ← carry provider token usage + cost
 *   ├── scorer (SCORER)        ← an LLM judge's calls (if any) nest here
 *   └── scorer (SCORER)
 *
 * Usage lives on the **LLM leaf spans**, never on the TASK/SCORER/EVALUATION wrappers.
 * We therefore sum only usage-bearing leaves and attribute each to the nearest TASK or
 * SCORER ancestor — so application (task) cost is separated from evaluation-judge
 * (scorer) cost, and a wrapper is never summed on top of its children (no double count).
 *
 * States: `pending` (no trace yet — it may still be ingesting), `unknown` (a trace with
 * no provider usage anywhere), `present` (real usage found). A real zero is only reported
 * when the trace proves zero; missing usage is never coerced to 0.
 */

export interface UsageSpan {
  span_id: string;
  parent_span_id: string | null;
  span_kind: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
}

export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  /** How many usage-bearing leaf spans were summed into this bucket. */
  spanCount: number;
}

export type UsageState = "pending" | "unknown" | "present";

export interface TraceUsage {
  /** Application/task LLM usage. */
  task: UsageBucket;
  /** Evaluation-judge (scorer) LLM usage. */
  scorer: UsageBucket;
  /** LLM usage under neither a task nor a scorer subtree. */
  other: UsageBucket;
  /** task + scorer + other. */
  combined: UsageBucket;
  state: UsageState;
}

const WRAPPER_KINDS = new Set(["EVALUATION", "TASK", "SCORER"]);

function emptyBucket(): UsageBucket {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, spanCount: 0 };
}

/** A span carries provider usage if any token count or a cost is present. */
function hasUsage(s: UsageSpan): boolean {
  return (
    s.input_tokens !== null ||
    s.output_tokens !== null ||
    s.total_tokens !== null ||
    s.cost !== null
  );
}

function addUsage(bucket: UsageBucket, s: UsageSpan): void {
  bucket.inputTokens += s.input_tokens ?? 0;
  bucket.outputTokens += s.output_tokens ?? 0;
  bucket.totalTokens += s.total_tokens ?? (s.input_tokens ?? 0) + (s.output_tokens ?? 0);
  bucket.cost += s.cost ?? 0;
  bucket.spanCount += 1;
}

/**
 * Walk from a span up its parent chain to the nearest TASK or SCORER ancestor.
 * Returns "task", "scorer", or "other" (reached the root/EVALUATION without either).
 * Guards against cycles.
 */
function attributionOf(span: UsageSpan, byId: Map<string, UsageSpan>): "task" | "scorer" | "other" {
  const seen = new Set<string>();
  let cur: UsageSpan | undefined = span;
  while (cur) {
    if (seen.has(cur.span_id)) break;
    seen.add(cur.span_id);
    if (cur !== span) {
      if (cur.span_kind === "TASK") return "task";
      if (cur.span_kind === "SCORER") return "scorer";
    }
    cur = cur.parent_span_id ? byId.get(cur.parent_span_id) : undefined;
  }
  return "other";
}

export function attributeTraceUsage(spans: UsageSpan[] | null | undefined): TraceUsage {
  const task = emptyBucket();
  const scorer = emptyBucket();
  const other = emptyBucket();
  const combined = emptyBucket();

  if (!spans || spans.length === 0) {
    return { task, scorer, other, combined, state: "pending" };
  }

  const byId = new Map(spans.map((s) => [s.span_id, s]));
  let found = false;

  for (const s of spans) {
    // Sum only usage-bearing LEAF spans — never the TASK/SCORER/EVALUATION wrappers,
    // whose children already carry the usage (summing both would double-count).
    if (WRAPPER_KINDS.has(s.span_kind)) continue;
    if (!hasUsage(s)) continue;
    found = true;
    const where = attributionOf(s, byId);
    addUsage(where === "task" ? task : where === "scorer" ? scorer : other, s);
    addUsage(combined, s);
  }

  return { task, scorer, other, combined, state: found ? "present" : "unknown" };
}
