/**
 * Agent-service self-tracing: every RCA execution and chat turn becomes a trace in
 * the customer's project, exported through the secret-gated internal route with the
 * agent's own credential (the route stamps source='agent' from it). Modelled on the
 * worker's detection/self-trace-emitter.ts: init is latched, and no tracing failure
 * ever fails the run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { TraceRoot, observe } from "@traceroot-ai/traceroot";
import { redactSecrets } from "@traceroot/core/capture-policy";

export type AgentTraceKind = "rca" | "followup" | "chat";
const AGENT_TRACE_KINDS: ReadonlySet<string> = new Set<AgentTraceKind>(["rca", "followup", "chat"]);
/**
 * `available` is optimistic: it means this turn's flush resolved, and flushes
 * are serialised per process so a rejection lands on the turn whose spans were
 * in flight — but the SDK's exporter is process-wide, so a batch holding this
 * turn's spans can still fail after its flush resolved. Per-trace export
 * confirmation needs SDK support.
 */
export type AgentTraceOutcome = "disabled" | "available" | "failed";
export interface AgentTraceMeta {
  traceId: string;
  projectId: string;
  kind: AgentTraceKind;
  name: string;
  metadata: Record<string, unknown>;
  /** The turn's user message — recorded (redacted, capped) as the root span's input. */
  input?: string;
}

/** Root-span I/O cap (spec B8): the root carries the prompt and the final answer, bounded. */
const ROOT_IO_CAP = 16_384;

/** Root attribute ingest promotes to the trace record's `metadata` (otel_transform.py). */
const TRACE_METADATA = "traceroot.trace.metadata";

function rootMetadata(meta: AgentTraceMeta): Record<string, unknown> {
  return { kind: meta.kind, ...meta.metadata };
}

function boundedText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const redacted = redactSecrets(text);
  return redacted.length > ROOT_IO_CAP ? `${redacted.slice(0, ROOT_IO_CAP)}…` : redacted;
}

const FLUSH_TIMEOUT_MS = 30_000;

// Unknown AGENT_SELF_TRACE_KINDS tokens already warned about; a typo in a staged
// rollout must be visible once, not on every turn.
const warnedKindTokens = new Set<string>();

export function isAgentTraceEnabled(kind: AgentTraceKind): boolean {
  const flag = process.env.AGENT_SELF_TRACE;
  if (flag !== "1" && flag !== "true") return false;
  const list = process.env.AGENT_SELF_TRACE_KINDS;
  if (!list) return true;
  const tokens = list
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of tokens) {
    if (!AGENT_TRACE_KINDS.has(token) && !warnedKindTokens.has(token)) {
      warnedKindTokens.add(token);
      console.warn(
        `[AgentTrace] AGENT_SELF_TRACE_KINDS token "${token}" is not one of ${[...AGENT_TRACE_KINDS].join(", ")}; ignored`,
      );
    }
  }
  return tokens.includes(kind);
}

/** Longest a single detector name may occupy in a root span name. */
const DETECTOR_NAME_CAP = 40;

/**
 * Root span name for an RCA execution.
 *
 * A finding can fire on any number of detectors, and detector names are free
 * text, so joining them all produces a name that grows without bound and reads
 * as noise in the trace tree. One detector is worth naming — it says what the
 * analysis is about. Beyond that the count is the only honest summary: the full
 * list is on the root span's `metadata.detectors` and spelled out in its input.
 */
export function rcaSpanName(detectors: readonly string[] | undefined): string {
  const named = (detectors ?? []).map((d) => d.trim()).filter(Boolean);
  if (named.length === 0) return "rca";
  if (named.length === 1) {
    const only = named[0] as string;
    const short =
      only.length > DETECTOR_NAME_CAP ? `${only.slice(0, DETECTOR_NAME_CAP - 1)}…` : only;
    return `rca: ${short}`;
  }
  return `rca: ${named.length} detectors`;
}

export function turnTraceId(sessionId: string, messageId: string): string {
  return createHash("sha256").update(`${sessionId}:${messageId}`).digest("hex").slice(0, 32);
}

// Per-run scope: the tool-span ids Task 10's onToolSpan reports, keyed by toolCallId,
// so the StreamPersister can stamp spanId on tool_step rows.
const runScope = new AsyncLocalStorage<{
  toolSpanIds: Map<string, string>;
  /** Capture budget for the spans this run emits — see currentCaptureState. */
  captureState: { spentBytes: number };
}>();
export function currentToolSpanIds(): Map<string, string> | undefined {
  return runScope.getStore()?.toolSpanIds;
}
export function recordToolSpan(info: { toolCallId: string; spanId: string }): void {
  runScope.getStore()?.toolSpanIds.set(info.toolCallId, info.spanId);
}

/**
 * The run's SPAN capture-budget accumulator, for the instrumentation's
 * per-tool callback (agent.ts's captureToolIo). The callback is invoked once
 * per tool call, so allocating a fresh accumulator there would reset the
 * per-run budget on every call and leave only the per-step cap in force —
 * spans would keep capturing without bound across a long run. This budget is
 * scoped to the span sink only: the StreamPersister that mirrors the same
 * events into AIMessage rows keeps its own separate accumulator (see
 * StreamPersisterOptions.state) so the two sinks don't halve each other's
 * effective cap. Outside a run (a customer using the SDK standalone) there is
 * no budget to share; the caller allocates its own.
 */
export function currentCaptureState(): { spentBytes: number } | undefined {
  return runScope.getStore()?.captureState;
}

let initialized = false;
let latchedOff = false;

function initOnce(): boolean {
  if (initialized) return true;
  if (latchedOff) return false;
  const secret = process.env.INTERNAL_API_SECRET_AGENT || "";
  if (!secret) {
    latchedOff = true;
    console.warn("[AgentTrace] INTERNAL_API_SECRET_AGENT unset; agent self-trace disabled");
    return false;
  }
  try {
    TraceRoot.initialize({
      baseUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
      internalExport: { path: "/api/v1/internal/traces", headers: { "X-Internal-Secret": secret } },
    });
    // initialize() not throwing is not the same as tracing being on: the SDK
    // no-ops when it is disabled, and it declines to register when another OTel
    // provider already owns the global. Either way no span reaches the internal
    // route — and without this check every run would still ack `available`,
    // publishing links to traces that do not exist. Same guard the worker's
    // emitter applies.
    if (!TraceRoot.isTracingActive()) {
      latchedOff = true;
      console.warn("[AgentTrace] SDK initialized but tracing is not active; self-trace disabled");
      return false;
    }
    initialized = true;
    return true;
  } catch (err) {
    latchedOff = true;
    console.error("[AgentTrace] SDK initialization failed; agent self-trace disabled:", err);
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`flush timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

// TraceRoot.flush() is process-wide (one exporter for every turn), so
// concurrent turns' flushes are serialised: a rejection then belongs to the
// turn whose spans were in flight instead of to whichever turn awaited it.
let flushQueue: Promise<void> = Promise.resolve();
function flushSerialised(): Promise<void> {
  // The queue advances on the ACTUAL settlement of TraceRoot.flush(), not on
  // a timed-out view of it: the exporter is process-wide, so if a timeout let
  // the queue move on while the real flush was still running, the next
  // queued flush could start and overlap it — reopening the cross-turn
  // attribution race serialisation exists to close. The caller gets its own
  // timed-out view of that same underlying call; a timeout it sees does not
  // mean the underlying flush stopped, only that this call stopped waiting.
  const underlying = flushQueue.then(() => TraceRoot.flush());
  flushQueue = underlying.then(
    () => {},
    () => {},
  );
  return withTimeout(underlying, FLUSH_TIMEOUT_MS);
}

export async function withAgentTrace<T>(
  meta: AgentTraceMeta,
  fn: () => Promise<T>,
  options: {
    /** The run's final answer, recorded (redacted, capped) as the root span's output. */
    recordOutput?: (value: T) => string | undefined;
    /** An error the run resolved WITH (the agent failed but fn did not reject) — marks the root ERROR. */
    runError?: (value: T) => Error | undefined;
  } = {},
): Promise<{ value: T; trace: AgentTraceOutcome }> {
  if (!isAgentTraceEnabled(meta.kind) || !initOnce()) {
    return { value: await fn(), trace: "disabled" };
  }
  // The root's I/O is set by hand (not observe's auto-capture): fn takes no
  // arguments and returns nothing useful, while the meaningful boundary is the
  // user message in and the assistant's final text out. Same attribute names
  // the worker's self-trace emitter uses for its root.
  // Whether fn() got to run inside observe(). If observe rejects before that —
  // forced-id validation, span setup, a provider that declined to register —
  // the turn must still happen, untraced. If it rejects after, the error is
  // fn's own and belongs to the caller. Without this distinction a tracing
  // failure would abort the agent run, which is the one thing self-tracing
  // must never do.
  // Three states, not two. `entered` alone says fn started, which is not enough:
  // if fn succeeded and observe then threw while closing spans, treating that as
  // fn's failure would abort a turn that already worked. So the outcome is
  // captured as fn produces it, and only a rejection with no outcome is fn's own.
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  const traced = async (): Promise<T> => {
    const root = trace.getActiveSpan();
    // observe() stamps `metadata` on the root SPAN only. The trace record's
    // metadata — what the viewer reads (kind, finding_id, attempt,
    // scanned_trace_id …) — is filled by ingest from this separate root
    // attribute, so stamp it here too. Set before fn runs so it survives a
    // failed run.
    if (root) root.setAttribute(TRACE_METADATA, JSON.stringify(rootMetadata(meta)));
    const input = boundedText(meta.input);
    if (root && input !== undefined) root.setAttribute("traceroot.span.input", input);
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      outcome = { ok: false, error: err };
      throw err; // let observe close its spans with the error
    }
    outcome = { ok: true, value };
    try {
      const output = boundedText(options.recordOutput?.(value));
      if (root && output !== undefined) root.setAttribute("traceroot.span.output", output);
      const runError = options.runError?.(value);
      if (root && runError) {
        root.recordException(runError);
        root.setStatus({ code: SpanStatusCode.ERROR, message: runError.message });
      }
    } catch (err) {
      console.error("[AgentTrace] root output capture failed:", err);
    }
    return value;
  };
  let value: T;
  try {
    value = await runScope.run({ toolSpanIds: new Map(), captureState: { spentBytes: 0 } }, () =>
      observe(
        {
          name: meta.name,
          type: "agent",
          traceId: meta.traceId,
          projectId: meta.projectId,
          metadata: rootMetadata(meta),
          captureInput: false,
          captureOutput: false,
        },
        traced,
      ),
    );
  } catch (err) {
    // fn ran and failed: its error is the caller's, and observe rethrowing it is
    // expected. Anything else surfacing here is a tracing failure on top of
    // it, which must not go unlogged.
    if (outcome && !outcome.ok) {
      if (err !== outcome.error) {
        console.error("[AgentTrace] tracing failed while closing after the run's error:", err);
      }
      throw outcome.error;
    }
    // fn ran and succeeded, but tracing threw while closing out. The turn
    // happened; losing it to a tracing failure is exactly what must not occur.
    if (outcome?.ok) {
      console.error("[AgentTrace] tracing failed after the run completed:", err);
      return { value: outcome.value, trace: "failed" };
    }
    // fn never ran — observe failed during setup. Run the turn untraced; never
    // rerun one that already happened.
    console.error("[AgentTrace] observe failed before the run; running untraced:", err);
    return { value: await fn(), trace: "failed" };
  }
  try {
    await flushSerialised();
    return { value, trace: "available" };
  } catch (err) {
    console.error(`[AgentTrace] export failed for trace ${meta.traceId}:`, err);
    return { value, trace: "failed" };
  }
}
