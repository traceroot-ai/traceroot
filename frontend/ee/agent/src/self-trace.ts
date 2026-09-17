/**
 * Agent-service self-tracing: every RCA execution and chat turn becomes a trace in
 * the customer's project, exported through the secret-gated internal route with the
 * agent's own credential (the route stamps source='agent' from it). Modelled on the
 * worker's detection/self-trace-emitter.ts: init is latched, and no tracing failure
 * ever fails the run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { exportAgentSpan } from "./sandbox-spans.js";
import { createHash } from "node:crypto";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { TraceRoot, observe } from "@traceroot-ai/traceroot";
import { capText } from "@traceroot/core/capture-policy";
import { agentInternalSecret } from "./internal-secret.js";

export type AgentTraceKind = "rca" | "followup" | "chat";
const AGENT_TRACE_KINDS: ReadonlySet<string> = new Set<AgentTraceKind>(["rca", "followup", "chat"]);
/**
 * `available` is optimistic: it means this turn's flush resolved, and flushes
 * are serialised per process so a rejection lands on the turn whose spans were
 * in flight — but the SDK's exporter is process-wide, so a batch holding this
 * turn's spans can still fail after its flush resolved. Per-trace export
 * confirmation needs SDK support.
 */
/**
 * `pending` is what a deferred flush reports at the turn's end: the spans are
 * recorded and the upload runs afterwards; `flushed` settles to available or
 * failed and the caller writes that onto the persisted row.
 */
export type AgentTraceOutcome = "disabled" | "available" | "failed" | "pending";
export interface AgentTraceMeta {
  traceId: string;
  projectId: string;
  kind: AgentTraceKind;
  name: string;
  metadata: Record<string, unknown>;
  /** The turn's user message — recorded (redacted, capped) as the root span's input. */
  input?: string;
  /**
   * The system prompt the agent ran with — recorded once, on the root, as
   * `traceroot.agent.system_prompt` (redacted, capped), instead of on every
   * LLM span, where it would crowd out the messages.
   */
  systemPrompt?: string;
}

/** Root-span I/O cap in UTF-8 bytes (spec B8): the root carries the prompt and the final answer, bounded. */
const ROOT_IO_CAP = 16_384;

/** Root attribute ingest promotes to the trace record's `metadata` (otel_transform.py). */
const TRACE_METADATA = "traceroot.trace.metadata";

function rootMetadata(meta: AgentTraceMeta): Record<string, unknown> {
  // `kind` is the trace's own field: a caller's metadata cannot relabel it.
  return { ...meta.metadata, kind: meta.kind };
}

/**
 * Redact, then bound to ROOT_IO_CAP bytes (marker included, byte-safe) and
 * set on the root; a cut marks the root `traceroot.truncated`, the same
 * attribute every LLM and tool span carries when its capture cut (design B7).
 */
function setBounded(root: Span | undefined, key: string, text: string | undefined): void {
  if (!root || !text) return;
  const cut = capText(text, ROOT_IO_CAP);
  root.setAttribute(key, cut.text);
  if (cut.truncated) root.setAttribute("traceroot.truncated", true);
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

/**
 * Root span name for every agent turn.
 *
 * Whatever started the turn — a detector's RCA, a follow-up in that chat, a
 * chat the user opened — it is the same pi-mono coding agent that runs, so
 * the root is named after it, the way a customer's root span names their
 * agent, and reads the same across the trace list. What the turn was
 * (`kind`), and for an RCA which detectors fired (`detectors`), is on the
 * root span's metadata and spelled out in its input; the kind used to be the
 * name for follow-ups and chats and the detectors for RCAs ("rca: 2
 * detectors"), which read as labels for the finding rather than for the thing
 * that ran (UX review, 2026-09-15).
 */
export const ROOT_SPAN_NAME = "pi-mono";

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
  const secret = agentInternalSecret();
  if (!secret) {
    latchedOff = true;
    console.warn("[AgentTrace] INTERNAL_API_SECRET_AGENT unset; agent self-trace disabled");
    return false;
  }
  try {
    TraceRoot.initialize({
      baseUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
      internalExport: { path: "/api/v1/internal/traces", headers: { "X-Internal-Secret": secret } },
      // The sandbox client's own HTTP-call spans carry no input or output and
      // shadow the tool spans that do; see sandbox-spans.ts.
      exportSpan: exportAgentSpan,
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
      // The provider initialize() built is not the global one; release its
      // exporter and batch processor rather than leave them idling.
      void TraceRoot.shutdown().catch(() => {});
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
    /**
     * `await` (default): the call resolves once the trace is uploaded, with
     * the final status. `defer`: the call resolves as soon as the run's spans
     * are closed, with `trace: "pending"` and a `flushed` promise for the
     * upload's outcome — for a turn a user is waiting on, which must not sit
     * behind a slow ingest (the flush queue is process-wide, 30 s timeout).
     */
    flush?: "await" | "defer";
  } = {},
): Promise<{ value: T; trace: AgentTraceOutcome; flushed?: Promise<"available" | "failed"> }> {
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
    setBounded(root, "traceroot.span.input", meta.input);
    setBounded(root, "traceroot.agent.system_prompt", meta.systemPrompt);
    let value: T;
    try {
      value = await fn();
    } catch (err) {
      outcome = { ok: false, error: err };
      throw err; // let observe close its spans with the error
    }
    outcome = { ok: true, value };
    try {
      setBounded(root, "traceroot.span.output", options.recordOutput?.(value));
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
  const flushed = flushSerialised().then(
    () => "available" as const,
    (err: unknown) => {
      console.error(`[AgentTrace] export failed for trace ${meta.traceId}:`, err);
      return "failed" as const;
    },
  );
  if (options.flush === "defer") return { value, trace: "pending", flushed };
  return { value, trace: await flushed };
}
