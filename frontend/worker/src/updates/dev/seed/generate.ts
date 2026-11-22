import type { UpdateWindows } from "@traceroot/core/updates";
import { Rng, chDateTime, hexId, normalQuantile } from "./prng.js";
import {
  INJECTION_TEXT,
  INJECTION_TRACE,
  MODEL_NANO_PRICES,
  type ProjectPlan,
  type WorkflowPlan,
} from "./plan.js";
import type { SpanRow, TraceRow } from "./types.js";

const MIN = 60_000;
/** Traces end well before the window does, so a trace and its spans share a window. */
const END_GUARD_MS = 2 * MIN;
const MAX_DURATION_MS = 50_000;

export type WindowKind = "prev" | "cur";

export interface GeneratedTrace {
  traceId: string;
  workflow: string;
  window: WindowKind;
  startMs: number;
  durationMs: number;
  ref: string | null;
  failed: boolean;
}

export interface GeneratedProject {
  traces: TraceRow[];
  spans: SpanRow[];
  meta: GeneratedTrace[];
}

export interface GenerateInput {
  seed: string;
  plan: ProjectPlan;
  projectId: string;
  windows: UpdateWindows;
  /** Commit shas by ref key; refs are only used for projects with a repo. */
  refShas: Record<string, string>;
}

export function nanoToDecimal(nano: number): string {
  const whole = Math.floor(nano / 1e9);
  const frac = String(nano % 1e9).padStart(9, "0");
  return `${whole}.${frac}`;
}

function windowBounds(windows: UpdateWindows, kind: WindowKind): [number, number] {
  return kind === "cur"
    ? [windows.windowStart.getTime(), windows.windowEnd.getTime()]
    : [windows.prevWindowStart.getTime(), windows.prevWindowEnd.getTime()];
}

/** The ref a trace carries: the base commit until the workflow's own timeline moves on. */
function refAt(workflow: WorkflowPlan, fraction: number): string {
  if (!workflow.refs) return "base";
  let current = workflow.refs[0].key;
  for (const ref of workflow.refs) if (fraction >= ref.fromFraction) current = ref.key;
  return current;
}

/** Rows for one project: both windows, every workflow. Pure and deterministic. */
export function generateProject(input: GenerateInput): GeneratedProject {
  const { plan, projectId, windows, refShas } = input;
  const traces: TraceRow[] = [];
  const spans: SpanRow[] = [];
  const meta: GeneratedTrace[] = [];
  const gitRepo = plan.gitRepo;

  for (const workflow of plan.workflows) {
    for (const kind of ["prev", "cur"] as const) {
      const count = workflow.traces[kind];
      if (count === 0) continue;
      const rng = new Rng(`${input.seed}|${projectId}|${workflow.name}|${kind}`);
      const [start, end] = windowBounds(windows, kind);
      const usable = end - start - END_GUARD_MS;

      // Latencies sit on a log-normal curve at evenly spaced quantiles, shuffled
      // over the traces, so the percentiles are set by the plan and not by luck.
      const order = rng.shuffle(Array.from({ length: count }, (_, i) => i));
      const durations = order.map((rank) => {
        const z = normalQuantile((rank + 0.5) / count);
        const ms = workflow.p50Ms[kind] * Math.exp(workflow.sigma * z);
        return Math.min(MAX_DURATION_MS, Math.max(50, Math.round(ms)));
      });

      const slots = Array.from({ length: count }, (_, i) => {
        const offset = (i + 0.1 + 0.8 * rng.next()) / count;
        return { startMs: start + Math.floor(offset * usable), fraction: offset };
      });
      const refs = slots.map((slot) =>
        !gitRepo ? null : kind === "cur" ? refAt(workflow, slot.fraction) : "base",
      );

      // Failures are chosen per ref group, so a ref's error rate is exact.
      const groups = new Map<string, number[]>();
      refs.forEach((ref, index) => {
        const list = groups.get(ref ?? "") ?? [];
        list.push(index);
        groups.set(ref ?? "", list);
      });
      const failing = new Set<number>();
      for (const [ref, indexes] of groups) {
        const rate =
          kind === "cur"
            ? (workflow.errorRate.curByRef?.[ref] ?? workflow.errorRate.cur)
            : workflow.errorRate.prev;
        const failures = Math.round(rate * indexes.length);
        for (const index of rng.shuffle(indexes).slice(0, failures)) failing.add(index);
      }
      let injectionsLeft = kind === "cur" ? (workflow.injectedFailures ?? 0) : 0;

      for (let i = 0; i < count; i += 1) {
        const startMs = slots[i].startMs;
        const durationMs = durations[i];
        const ref = refs[i];
        const failed = failing.has(i);
        const traceId = hexId(`${projectId}|${workflow.name}|${kind}|${i}`, 32);
        const spanId = (n: number) => hexId(`${projectId}|${traceId}|span${n}`, 16);
        const injected = failed && injectionsLeft > 0;
        if (injected) injectionsLeft -= 1;

        meta.push({
          traceId,
          workflow: workflow.name,
          window: kind,
          startMs,
          durationMs,
          ref,
          failed,
        });
        traces.push({
          trace_id: traceId,
          project_id: projectId,
          trace_start_time: chDateTime(startMs),
          name: workflow.name,
          user_id: `user-${i % 25}`,
          session_id: `session-${hexId(`${projectId}|${workflow.name}|${kind}|${Math.floor(i / 4)}`, 8)}`,
          git_ref: ref ? refShas[ref] : null,
          git_repo: ref ? gitRepo : null,
          input: JSON.stringify({
            request: injected ? INJECTION_TEXT(INJECTION_TRACE) : `${workflow.name} request ${i}`,
          }),
          output: failed ? null : JSON.stringify({ answer: `${workflow.name} answer ${i}` }),
          metadata: null,
          environment: "production",
          source: "user",
          is_evaluation: 0,
        });

        const rootId = spanId(0);
        const sourceFile = ref ? (workflow.sourceFile ?? null) : null;
        spans.push(
          spanRow({
            spanId: rootId,
            traceId,
            parent: null,
            projectId,
            name: workflow.name,
            kind: "AGENT",
            startMs,
            endMs: startMs + durationMs,
            failed: false,
            sourceFile,
          }),
        );

        // The failing span: a tool when the trace calls one, else the last model call.
        const tools = workflow.tools.filter(
          (tool) =>
            tool.windows.includes(kind) &&
            (tool.onlyRef === undefined || tool.onlyRef === ref) &&
            rng.next() < tool.share,
        );
        const price = MODEL_NANO_PRICES[workflow.model];
        const jitter = () => 0.92 + 0.16 * rng.next();
        const tokenPlan = workflow.tokens[kind];
        let cursor = startMs + Math.floor(durationMs * 0.05);
        const slice = Math.floor((durationMs * 0.9) / (workflow.llmCalls + tools.length));
        let n = 1;
        const toolNames = tools.map((t) => t.name);
        const failAt = failed ? (toolNames.length > 0 ? "tool" : "llm") : null;
        for (let call = 0; call < workflow.llmCalls; call += 1) {
          const input = Math.round(tokenPlan.input * jitter());
          const output = Math.round(tokenPlan.output * jitter());
          const isLastCall = call === workflow.llmCalls - 1;
          const errored = failAt === "llm" && isLastCall;
          spans.push(
            spanRow({
              spanId: spanId(n),
              traceId,
              parent: rootId,
              projectId,
              name: `chat ${workflow.model}`,
              kind: "LLM",
              startMs: cursor,
              endMs: cursor + slice,
              failed: errored,
              model: workflow.model,
              input,
              output,
              nano: input * price.input + output * price.output,
              sourceFile,
              injected: errored && injected,
            }),
          );
          n += 1;
          cursor += slice;
        }
        toolNames.forEach((toolName, index) => {
          const errored = failAt === "tool" && index === toolNames.length - 1;
          spans.push(
            spanRow({
              spanId: spanId(n),
              traceId,
              parent: rootId,
              projectId,
              name: toolName,
              kind: "TOOL",
              startMs: cursor,
              endMs: cursor + slice,
              failed: errored,
              sourceFile,
              injected: errored && injected,
            }),
          );
          n += 1;
          cursor += slice;
        });
      }
    }
  }
  return { traces, spans, meta };
}

interface SpanArgs {
  spanId: string;
  traceId: string;
  parent: string | null;
  projectId: string;
  name: string;
  kind: SpanRow["span_kind"];
  startMs: number;
  endMs: number;
  failed: boolean;
  model?: string;
  input?: number;
  output?: number;
  nano?: number;
  sourceFile: string | null;
  injected?: boolean;
}

function spanRow(a: SpanArgs): SpanRow {
  const message = a.failed
    ? a.injected
      ? `upstream replied: ${INJECTION_TEXT(INJECTION_TRACE)}`
      : a.kind === "TOOL"
        ? `${a.name} returned status 500`
        : "model request timed out"
    : null;
  return {
    span_id: a.spanId,
    trace_id: a.traceId,
    parent_span_id: a.parent,
    project_id: a.projectId,
    span_start_time: chDateTime(a.startMs),
    span_end_time: chDateTime(a.endMs),
    name: a.name,
    span_kind: a.kind,
    status: a.failed ? "ERROR" : "OK",
    status_message: message,
    model_name: a.model ?? null,
    cost: a.nano === undefined ? null : nanoToDecimal(a.nano),
    input_tokens: a.input ?? null,
    output_tokens: a.output ?? null,
    total_tokens: a.input === undefined ? null : a.input + (a.output ?? 0),
    input: a.injected ? JSON.stringify({ note: INJECTION_TEXT(INJECTION_TRACE) }) : null,
    output: null,
    git_source_file: a.sourceFile,
    usage_details: {},
    environment: "production",
    source: "user",
    is_evaluation: 0,
    error_type: a.failed ? (a.kind === "TOOL" ? "tool_error" : "provider_timeout") : "",
  };
}
