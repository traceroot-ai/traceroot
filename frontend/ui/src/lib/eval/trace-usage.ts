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
 * We therefore sum only usage-bearing leaves and attribute each by whether it falls
 * under a SCORER subtree — so application (task) cost is separated from evaluation-judge
 * (scorer) cost, and a wrapper is never summed on top of its children (no double count).
 *
 * The attribution rule matches the backend's `_task_cost_by_trace`
 * (backend/worker/ingest_tasks.py): a span under a SCORER (an LLM judge or a hand-rolled
 * scorer that calls a provider directly) is scorer cost; everything else is task cost.
 * There is no third "neither" bucket on either side — an LLM span with no TASK wrapper
 * (e.g. emitted directly under the EVALUATION root) is task cost, not excluded, on both
 * surfaces, so the two numbers rendered side by side on the compare views never disagree.
 *
 * States: `pending` (no trace yet — it may still be ingesting), `unknown` (a trace with
 * no provider usage anywhere), `present` (real usage found). A real zero is only reported
 * when the trace proves zero; missing usage is never coerced to 0.
 *
 * Models: each bucket also carries the DISTINCT observed model names of the leaves
 * summed into it (`task.models` = candidate models, `scorer.models` = judge models),
 * taken from the span's reported `model_name` and never inferred from a candidate
 * label. A leaf with no reported model contributes nothing, so an empty `models` is an
 * honest "not attributed" rather than a guess.
 *
 * Scope: this attributes a SINGLE trace (per-result). A per-RUN aggregate of observed
 * models is NOT derivable here — it would require the ingest worker to denormalize the
 * per-result model onto `EvaluationResult` (as it already does for `cost`). Until that
 * source exists, callers should report per-run observed models as unknown rather than
 * summing traces client-side, and candidate performance comparisons must use the task
 * bucket only (judge/scorer overhead is shown separately and never enters the verdict).
 */

export interface UsageSpan {
  span_id: string;
  parent_span_id: string | null;
  span_kind: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  /** The OBSERVED model on this LLM leaf (from the span, never inferred from a
   *  candidate label). Null when the span didn't report one. */
  model_name: string | null;
}

export interface UsageBucket {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  /** Whether ANY leaf summed here reported a cost. `cost === 0` with `costKnown` false
   *  is "cost not attributed yet" (show Unknown); with `costKnown` true it's a genuine
   *  zero. Ingest can attach token usage before it computes cost, so the two differ. */
  costKnown: boolean;
  /** Whether ANY leaf summed here reported a token count. A leaf that reported only a cost
   *  leaves the tokens unknown, so `totalTokens === 0` reads as a genuine zero only when this
   *  is true. */
  tokensKnown: boolean;
  /** How many usage-bearing leaf spans were summed into this bucket. */
  spanCount: number;
  /** Distinct OBSERVED model names among the leaves summed here (sorted). Empty when
   *  no leaf reported a model — models are observed, never inferred from a label. */
  models: string[];
}

export type UsageState = "pending" | "unknown" | "present";

export interface TraceUsage {
  /** Candidate-task LLM usage: everything not under a SCORER subtree. */
  task: UsageBucket;
  /** Evaluation-judge (scorer) LLM usage: spans under a SCORER subtree. */
  scorer: UsageBucket;
  /** task + scorer. */
  combined: UsageBucket;
  state: UsageState;
}

const WRAPPER_KINDS = new Set(["EVALUATION", "TASK", "SCORER"]);

function emptyBucket(): UsageBucket {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cost: 0,
    costKnown: false,
    tokensKnown: false,
    spanCount: 0,
    models: [],
  };
}

/** A span carries provider usage if any token count or a cost is present. A streamed span
 *  that hasn't reported usage lacks the keys altogether, so a missing key reads like a null one. */
function hasUsage(s: UsageSpan): boolean {
  return (
    s.input_tokens != null || s.output_tokens != null || s.total_tokens != null || s.cost != null
  );
}

/** A span's token total: the reported total, else input + output; null when it reported
 *  no tokens at all, never 0. A streamed span with no usage lacks the keys altogether, so
 *  a missing key reads like a null one. */
export function spanTotalTokens(
  s: Pick<UsageSpan, "input_tokens" | "output_tokens" | "total_tokens">,
): number | null {
  if (s.total_tokens != null) return s.total_tokens;
  if (s.input_tokens == null && s.output_tokens == null) return null;
  return (s.input_tokens ?? 0) + (s.output_tokens ?? 0);
}

function addUsage(bucket: UsageBucket, s: UsageSpan, models: Set<string>): void {
  bucket.inputTokens += s.input_tokens ?? 0;
  bucket.outputTokens += s.output_tokens ?? 0;
  const total = spanTotalTokens(s);
  bucket.totalTokens += total ?? 0;
  if (total !== null) bucket.tokensKnown = true;
  bucket.cost += s.cost ?? 0;
  if (s.cost != null) bucket.costKnown = true;
  bucket.spanCount += 1;
  if (s.model_name) models.add(s.model_name);
}

/**
 * Walk from a span up its parent chain: if any ancestor is a SCORER, the span is
 * judge (scorer) usage; otherwise it's candidate-task usage. This mirrors the
 * backend's `_task_cost_by_trace`, which excludes every span under a SCORER subtree
 * and counts everything else as task cost — there is no third "neither" bucket, so
 * a span with no TASK wrapper in its ancestry still counts as task, on both surfaces.
 * Guards against cycles.
 */
export function attributionOf(
  span: UsageSpan,
  byId: ReadonlyMap<string, UsageSpan>,
): "task" | "scorer" {
  const seen = new Set<string>();
  let cur: UsageSpan | undefined = span;
  while (cur) {
    if (seen.has(cur.span_id)) break;
    seen.add(cur.span_id);
    if (cur.span_kind === "SCORER") return "scorer";
    cur = cur.parent_span_id ? byId.get(cur.parent_span_id) : undefined;
  }
  return "task";
}

export function attributeTraceUsage(spans: UsageSpan[] | null | undefined): TraceUsage {
  const task = emptyBucket();
  const scorer = emptyBucket();
  const combined = emptyBucket();

  if (!spans || spans.length === 0) {
    return { task, scorer, combined, state: "pending" };
  }

  const byId = new Map(spans.map((s) => [s.span_id, s]));
  const taskModels = new Set<string>();
  const scorerModels = new Set<string>();
  const combinedModels = new Set<string>();
  let found = false;

  for (const s of spans) {
    // Sum only usage-bearing LEAF spans — never the TASK/SCORER/EVALUATION wrappers,
    // whose children already carry the usage (summing both would double-count).
    if (WRAPPER_KINDS.has(s.span_kind)) continue;
    if (!hasUsage(s)) continue;
    found = true;
    const where = attributionOf(s, byId);
    if (where === "task") addUsage(task, s, taskModels);
    else addUsage(scorer, s, scorerModels);
    addUsage(combined, s, combinedModels);
  }

  task.models = [...taskModels].sort();
  scorer.models = [...scorerModels].sort();
  combined.models = [...combinedModels].sort();

  // `present` once any span reported usage, on either side. A side none of whose spans
  // reported a token count (`tokensKnown` false) has unknown tokens, not 0: a task that made
  // no instrumented model call reads unknown next to a judge that reported usage, as an
  // uninstrumented call can't be told from none, and a span that reported only a cost says
  // nothing about its tokens.
  return { task, scorer, combined, state: found ? "present" : "unknown" };
}
