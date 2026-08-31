/**
 * Agent-service self-tracing: every RCA execution and chat turn becomes a trace in
 * the customer's project, exported through the secret-gated internal route with the
 * agent's own credential (the route stamps source='agent' from it). Modelled on the
 * worker's detection/self-trace-emitter.ts: init is latched, and no tracing failure
 * ever fails the run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { trace } from "@opentelemetry/api";
import { TraceRoot, observe } from "@traceroot-ai/traceroot";
import { redactSecrets } from "@traceroot/core/capture-policy";

export type AgentTraceKind = "rca" | "followup" | "chat";
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
export const ROOT_IO_CAP = 16_384;

function boundedText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const redacted = redactSecrets(text);
  return redacted.length > ROOT_IO_CAP ? `${redacted.slice(0, ROOT_IO_CAP)}…` : redacted;
}

const FLUSH_TIMEOUT_MS = 30_000;

export function isAgentTraceEnabled(kind: AgentTraceKind): boolean {
  if (process.env.AGENT_SELF_TRACE !== "1") return false;
  const list = process.env.AGENT_SELF_TRACE_KINDS;
  if (!list) return true;
  return list
    .split(",")
    .map((s) => s.trim())
    .includes(kind);
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
const runScope = new AsyncLocalStorage<{ toolSpanIds: Map<string, string> }>();
export function currentToolSpanIds(): Map<string, string> | undefined {
  return runScope.getStore()?.toolSpanIds;
}
export function recordToolSpan(info: { toolCallId: string; spanId: string }): void {
  runScope.getStore()?.toolSpanIds.set(info.toolCallId, info.spanId);
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

export async function withAgentTrace<T>(
  meta: AgentTraceMeta,
  fn: () => Promise<T>,
  options: { recordOutput?: (value: T) => string | undefined } = {},
): Promise<{ value: T; trace: AgentTraceOutcome }> {
  if (!isAgentTraceEnabled(meta.kind) || !initOnce()) {
    return { value: await fn(), trace: "disabled" };
  }
  // The root's I/O is set by hand (not observe's auto-capture): fn takes no
  // arguments and returns nothing useful, while the meaningful boundary is the
  // user message in and the assistant's final text out. Same attribute names
  // the worker's self-trace emitter uses for its root.
  const traced = async (): Promise<T> => {
    const root = trace.getActiveSpan();
    const input = boundedText(meta.input);
    if (root && input !== undefined) root.setAttribute("traceroot.span.input", input);
    const value = await fn();
    try {
      const output = boundedText(options.recordOutput?.(value));
      if (root && output !== undefined) root.setAttribute("traceroot.span.output", output);
    } catch (err) {
      console.error("[AgentTrace] root output capture failed:", err);
    }
    return value;
  };
  const value: T = await runScope.run({ toolSpanIds: new Map() }, () =>
    observe(
      {
        name: meta.name,
        type: "agent",
        traceId: meta.traceId,
        projectId: meta.projectId,
        metadata: { kind: meta.kind, ...meta.metadata },
        captureInput: false,
        captureOutput: false,
      },
      traced,
    ),
  );
  try {
    await withTimeout(TraceRoot.flush(), FLUSH_TIMEOUT_MS);
    return { value, trace: "available" };
  } catch (err) {
    console.error(`[AgentTrace] export failed for trace ${meta.traceId}:`, err);
    return { value, trace: "failed" };
  }
}
