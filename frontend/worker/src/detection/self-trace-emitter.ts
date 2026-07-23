/**
 * Best-effort self-tracing for detector runs, emitted through the traceroot
 * SDK's internal-export mode.
 *
 * The SDK owns the OTel pipeline: initialize() registers the global provider
 * with the internal OTLP exporter (X-Internal-Secret to the internal route),
 * observe() forces trace_id = dashless run id and carries the per-root
 * projectId that the SDK's span processor stamps as traceroot.project_id on
 * every span in the tree — the backend's detector-only wrapper routes each
 * span to its project by that attribute, so one worker process serves every
 * project over one exporter.
 *
 * withSelfTrace() records fn's execution live: the detector-run root is
 * active for fn's whole duration, so spans created inside — the traced pi-ai
 * judge call, any future auto-instrumented spans — parent into the
 * self-trace. Everything here is strictly best-effort: tracing failures log
 * and degrade to selfTraced=false; fn always runs exactly once; nothing
 * throws into a detector run.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { TraceRoot, observe } from "@traceroot-ai/traceroot";

export interface SelfTraceRunMeta {
  /** Run id; its dashless form is forced as the self-trace's trace id. */
  runId: string;
  projectId: string;
  detectorId: string;
  detectorName: string;
  /** The customer trace this run scanned. */
  scannedTraceId: string;
}

/** Active self-trace scope, visible to instrumentation (e.g. tracedComplete). */
export interface SelfTraceScope {
  /** Forced trace id — the dashless run id. */
  traceId: string;
  /** Project every span of this self-trace must be attributed to. */
  projectId: string;
}

export type SelfTracedRun<T> = { selfTraced: boolean } & (
  | { ok: true; value: T }
  | { ok: false; error: unknown }
);

export interface SelfTraceOptions<T> {
  /**
   * Derive the root span's boundary input/output from fn's result — the
   * transform promotes root I/O to the trace record, so this is what fills
   * the trace header (e.g. detector prompt in, verdict out). `error` marks a
   * run that resolved with a failure result (fn didn't throw, e.g. a provider
   * error verdict): the root span gets ERROR status with that message. Only
   * called on a resolved fn; must return already-bounded strings.
   */
  recordIo?: (value: T) => { input?: string; output?: string; error?: string };
}

const selfTraceScope = new AsyncLocalStorage<SelfTraceScope>();

/** The scope of the self-trace currently being recorded, if any. */
export function currentSelfTraceScope(): SelfTraceScope | undefined {
  return selfTraceScope.getStore();
}

let initialized = false;
let warnedDisabled = false;

/**
 * Initialize the SDK's internal-export pipeline once. No process-default
 * X-Project-Id is configured: every root carries its own projectId, and the
 * SDK drops any span that ends up unattributed rather than guessing. Without
 * a secret the emitter stays uninitialized (every run declines) — exporting
 * could only 403.
 */
export function initSelfTraceEmitter(): void {
  if (initialized) return;
  // Read at call time (not module load) so a late-injected env still takes
  // effect and tests can vary it.
  const secret = process.env.INTERNAL_API_SECRET || "";
  if (!secret) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn("[Detector] INTERNAL_API_SECRET unset; self-trace emit disabled");
    }
    return;
  }
  TraceRoot.initialize({
    baseUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
    internalExport: {
      path: "/api/v1/internal/traces",
      headers: { "X-Internal-Secret": secret },
    },
    globalAttributes: { "traceroot.source": "detector" },
  });
  initialized = true;
  console.log("[Detector] self-trace emitter initialized (internal export)");
}

/** Run fn plainly (no tracing), preserving the SelfTracedRun contract. */
async function runPlain<T>(fn: () => Promise<T>): Promise<SelfTracedRun<T>> {
  try {
    return { ok: true, value: await fn(), selfTraced: false };
  } catch (error) {
    return { ok: false, error, selfTraced: false };
  }
}

/**
 * Record fn's execution as the run's self-trace: a detector-run root span is
 * live for fn's whole duration, so spans created inside parent into it. fn
 * runs exactly once in every path; a tracing failure degrades to
 * selfTraced=false rather than affecting the run. The returned selfTraced is
 * optimistic — the SDK's batch processor exports asynchronously later.
 */
export async function withSelfTrace<T>(
  meta: SelfTraceRunMeta,
  fn: () => Promise<T>,
  options: SelfTraceOptions<T> = {},
): Promise<SelfTracedRun<T>> {
  try {
    if (!initialized) initSelfTraceEmitter();
  } catch (err) {
    console.error("[Detector] self-trace init failed:", err);
  }
  if (!initialized) return runPlain(fn);

  let traceId: string;
  try {
    traceId = meta.runId.replaceAll("-", "");
  } catch (err) {
    console.error("[Detector] self-trace setup failed:", err);
    return runPlain(fn);
  }
  const scope: SelfTraceScope = { traceId, projectId: meta.projectId };

  // Tracks how far fn itself got: if observe's machinery throws BEFORE
  // reaching fn, we must still run fn exactly once (plainly); if it throws
  // AFTER fn completed, the run succeeded and only the tracing is lost.
  let fnRan = false;
  let fnCompleted = false;
  let fnValue: T | undefined;
  const wrapped = async (): Promise<T> => {
    fnRan = true;
    const value = await fn();
    fnValue = value;
    fnCompleted = true;
    try {
      if (options.recordIo) {
        const io = options.recordIo(value);
        const root = trace.getActiveSpan();
        if (io.input !== undefined) root?.setAttribute("traceroot.span.input", io.input);
        if (io.output !== undefined) root?.setAttribute("traceroot.span.output", io.output);
        // A run can resolve with a failure result (provider error, timeout,
        // missing key) without throwing — the root must not read as OK.
        if (io.error !== undefined) {
          root?.setStatus({ code: SpanStatusCode.ERROR, message: io.error });
        }
      }
    } catch (err) {
      console.error("[Detector] self-trace boundary io failed:", err);
    }
    return value;
  };

  try {
    const value = await selfTraceScope.run(scope, () =>
      observe(
        {
          // The trace record inherits this name, so both the trace node and
          // the root row read "which detector's run" at a glance.
          name: `detector-run: ${meta.detectorName}`,
          traceId,
          projectId: meta.projectId,
          metadata: {
            detectorId: meta.detectorId,
            detectorName: meta.detectorName,
            scannedTraceId: meta.scannedTraceId,
          },
          // recordIo owns the root's output (bounded); the SDK's default
          // capture would store fn's full result unbounded.
          captureOutput: false,
        },
        wrapped,
      ),
    );
    return { ok: true, value, selfTraced: true };
  } catch (error) {
    // fn finished but observe's machinery failed afterwards (e.g. ending the
    // root): the evaluation succeeded — return its value and only degrade the
    // tracing, which may not have exported.
    if (fnCompleted) {
      console.error("[Detector] self-trace observe failed after fn:", error);
      return { ok: true, value: fnValue as T, selfTraced: false };
    }
    // observe sets the root's error status and rethrows fn's error; if fn
    // never ran, the failure was tracing machinery — degrade and run plainly.
    if (fnRan) return { ok: false, error, selfTraced: true };
    console.error("[Detector] self-trace observe failed before fn:", error);
    return runPlain(fn);
  }
}

/**
 * Flush batched spans and shut the SDK pipeline down. Never rejects — an
 * export failure on the way out must not crash worker shutdown (flush()
 * rejects on export failure by contract).
 */
export async function shutdownSelfTraceEmitter(): Promise<void> {
  if (!initialized) return;
  initialized = false;
  try {
    await TraceRoot.flush();
  } catch (err) {
    console.error("[Detector] self-trace flush failed:", err);
  }
  try {
    await TraceRoot.shutdown();
  } catch (err) {
    console.error("[Detector] self-trace emitter shutdown failed:", err);
  }
}
