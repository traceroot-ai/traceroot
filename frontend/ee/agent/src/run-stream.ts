import type { Agent } from "@earendil-works/pi-agent-core";
import { runAgent } from "./agent.js";
import { clearSessionDeleted } from "./executors/deleted-session-fence.js";
import {
  CLIENT_DISCONNECTED_SKIP_REASON,
  pendingDecisions,
  RUN_ENDED_SKIP_REASON,
  RUN_ERROR_SKIP_REASON,
  type PendingDecisions,
} from "./pending-decisions.js";
import { StreamPersister } from "./stream-persister.js";
import { UsageAccumulator } from "./usage-accumulator.js";
import type { SessionManager, TokenUsageData, TurnAttribution } from "./session.js";
import { withAgentTrace, currentToolSpanIds, type AgentTraceMeta } from "./self-trace.js";
import { publicErrorMessage } from "@traceroot/core/public-error";

/**
 * The slice of hono's SSEStreamingApi the run needs — kept structural so
 * tests can drive the stream lifecycle without a real HTTP response.
 */
export interface AgentRunStream {
  writeSSE(message: { data: string; event?: string }): Promise<unknown> | unknown;
  write(input: string): Promise<unknown> | unknown;
  onAbort(callback: () => void | Promise<void>): void;
}

export interface RunStreamOptions {
  agent: Agent;
  message: string;
  sessionId: string;
  /** The requesting user who can answer confirmation cards (empty when unattended). */
  channelUserId: string;
  isByok: boolean;
  sessionManager: Pick<SessionManager, "appendMessage">;
  /**
   * Who and what this turn is, stamped on every row the run persists (the
   * assistant segments and the tool steps) — computed once by the route, so a
   * turn reads as one attributed unit.
   */
  attribution: TurnAttribution;
  /**
   * The turn's self-trace: when set, the run is wrapped in withAgentTrace
   * (root span, deterministic trace id, tool steps stamped with their span
   * ids) and the stream ends with a `trace` frame carrying the outcome.
   * Absent, the run is not traced and persists exactly what it always did.
   */
  trace?: AgentTraceMeta;
  /** Decision registry override for tests; defaults to the service singleton. */
  decisions?: PendingDecisions;
}

/** Sessions with a run in flight — one prompt per session at a time. */
const activeRuns = new Set<string>();

/**
 * Claim a session for a run; false when one is already in flight. The route
 * claims BEFORE persisting the user row or touching the cached agent, and
 * runAgentStream releases the claim when the run settles: a rival prompt on
 * a parked session would otherwise register a last-wins channel and, when
 * pi rejects the overlapping prompt, release the first run's healthy
 * proposal on its error path.
 */
export function claimRun(sessionId: string): boolean {
  if (activeRuns.has(sessionId)) return false;
  activeRuns.add(sessionId);
  return true;
}

export function releaseRun(sessionId: string): void {
  activeRuns.delete(sessionId);
  // The run is over, so the fence it was raised against has nothing left to
  // stop. Dropping it here — not in the delete route — is what bounds it: a
  // run that outlived the route's wait still releases its own mark.
  clearSessionDeleted(sessionId);
  const waiters = runSettledWaiters.get(sessionId);
  if (waiters === undefined) return;
  runSettledWaiters.delete(sessionId);
  for (const wake of waiters) wake();
}

/** Callbacks waiting on a session's run to settle, woken by releaseRun. */
const runSettledWaiters = new Map<string, Set<() => void>>();

/**
 * Resolve once no run is in flight for this session — immediately when none
 * is. Session teardown waits on this before destroying the executor: a run
 * resumed by the teardown's own decision release is still executing tools,
 * and tearing its sandbox down underneath it leaves the sandbox it re-creates
 * untracked.
 */
/** How long a delete waits for a run to settle before tearing down anyway. */
export const RUN_SETTLE_TIMEOUT_MS = 10_000;

export function waitForRunToSettle(
  sessionId: string,
  timeoutMs: number = RUN_SETTLE_TIMEOUT_MS,
): Promise<boolean> {
  if (!activeRuns.has(sessionId)) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const waiters = runSettledWaiters.get(sessionId) ?? new Set<() => void>();
    runSettledWaiters.set(sessionId, waiters);
    // Bounded on purpose: the session row is already gone by the time anyone
    // waits here, so a run that never settles must not hang the request. The
    // wait buys the executor teardown a quiet moment, it does not guarantee one.
    const finish = (settled: boolean) => {
      clearTimeout(timer);
      waiters.delete(wake);
      // A timeout leaves nobody waiting, and releaseRun may never come for
      // this session — drop the empty set rather than keep it for the life
      // of the process.
      if (waiters.size === 0) runSettledWaiters.delete(sessionId);
      resolve(settled);
    };
    const wake = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    waiters.add(wake);
  });
}

/**
 * Run one agent prompt into an SSE stream: forward events, persist the run,
 * and host the confirmation channel that lets the write-policy hook park
 * confirm-class tool calls on this stream. Releases the caller's run claim
 * (see claimRun) once the run settles.
 *
 * The parking release paths owned here: a run error, run completion, and a
 * client disconnect (stream abort) each resolve any still-parked decisions
 * as skip, so the turn can finish narrating instead of hanging forever.
 */
export async function runAgentStream(
  stream: AgentRunStream,
  options: RunStreamOptions,
): Promise<void> {
  const { agent, message, sessionId, decisions = pendingDecisions } = options;

  const append = (
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
    tokenUsage?: TokenUsageData,
  ) =>
    options.sessionManager.appendMessage(role, content, options.attribution, metadata, tokenUsage);
  // Accumulates token usage across all message_end events (tool-use loops)
  const usageAccumulator = new UsageAccumulator();
  let loggedFirstUpdate = false;

  // The write-policy hook parks confirm-class calls against this channel:
  // pending cards ride the same SSE stream as the run's other events, and
  // keepalive comments stop intermediaries from idle-closing it while the
  // agent silently waits on the user.
  const channel = {
    userId: options.channelUserId,
    emit: (event: { type: string }) =>
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event) }),
    keepalive: () => void stream.write(`: parked, awaiting a decision\n\n`),
  };
  decisions.registerChannel(sessionId, channel);
  stream.onAbort(() => {
    decisions.releaseSession(sessionId, CLIENT_DISCONNECTED_SKIP_REASON);
    // The turn keeps running after the client is gone: with the channel torn
    // down, a confirm-class call proposed later fails closed at once instead
    // of parking against the dead stream until the decision timeout.
    decisions.unregisterChannel(sessionId, channel);
  });

  // Runs the agent and resolves with the persister that mirrored the run into
  // AIMessage rows (text segments, tool steps) so reloaded history matches
  // what the live stream rendered, plus the error the run resolved with, if
  // any. The persister is built inside the run because withAgentTrace's
  // scope is only live in here: it stamps each tool_step row with the OTel
  // span id the instrumentation reported for that tool call. Its capture
  // budget is its OWN fresh accumulator — deliberately NOT the span budget
  // (currentCaptureState(), charged by agent.ts's captureToolIo callback):
  // the same tool event is policy-transformed once for the span sink and once
  // for the row sink, and each sink is bounded by perRunBytes on its own.
  const run = () =>
    new Promise<{ persister: StreamPersister; error?: Error }>((resolve) => {
      const persister = new StreamPersister(append, { toolSpanIds: currentToolSpanIds });
      runAgent(agent, message, {
        onEvent: (event) => {
          if (event.type === "message_update") {
            // Log only the very first message_update for debugging
            if (!loggedFirstUpdate) {
              loggedFirstUpdate = true;
              console.log(`[Agent] First message_update:`, JSON.stringify(event).slice(0, 500));
            }
          } else if (event.type !== "message_start") {
            // Skip noisy message_start, log other event types
            console.log(`[Agent] Event: ${event.type}`);
          }
          // Log error details from message_end
          if (event.type === "message_end") {
            const msg = (event as any).message;
            console.log(
              `[Agent] message_end:`,
              JSON.stringify({
                model: msg?.model,
                provider: msg?.provider,
                usage: msg?.usage,
                stopReason: msg?.stopReason,
              }).slice(0, 500),
            );
            if (msg?.stopReason === "error") {
              console.error(`[Agent] API error:`, msg.errorMessage || "unknown");
            }
          }
          // A declined proposal's blocked result leaves the loop with empty
          // details (the block path only carries text) — stamp the recorded
          // decline onto the surfaced result so the panel and reloaded
          // history can label the outcome without inference.
          let outbound = event;
          if (event.type === "tool_execution_end") {
            const declined = decisions.takeDecline(sessionId, event.toolCallId);
            if (declined !== undefined) {
              outbound = { ...event, result: { ...event.result, details: declined } };
            }
          }

          // Forward all events to the frontend
          stream.writeSSE({
            event: outbound.type,
            data: JSON.stringify(outbound),
          });

          // Mirror the event into token totals and durable rows
          usageAccumulator.onEvent(outbound);
          persister.onEvent(outbound);
        },
        onError: async (error) => {
          // Everything here is best-effort cleanup, and resolve() is what lets
          // the caller's finally release the run claim and unregister the
          // channel. A throw on any of it would strand this session in
          // activeRuns, 409-ing every later prompt for the life of the
          // process — so the resolve is owed unconditionally. The catch is
          // owed too: runAgent invokes this handler without awaiting it, so
          // anything escaping here is an unhandled rejection, which Node may
          // take the whole process down for.
          try {
            // Log the full error server-side; the raw provider/agent message
            // can carry internal detail (connection strings, stack frames)
            // and this SSE frame reaches the browser, so only a sanitised
            // form goes out over it.
            console.error(`[Agent] ERROR:`, error);
            // A dead run can never deliver a decision — unpark before anything else.
            decisions.releaseSession(sessionId, RUN_ERROR_SKIP_REASON);
            // Awaited so the terminal event is flushed before the stream closes.
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({ message: publicErrorMessage(error) }),
            });
            // A durable error marker, so reloaded history shows the failure
            // instead of a silent non-answer; the rows themselves are
            // flushed once, below, whatever the outcome.
            persister.recordError(error.message);
          } catch (cleanupError) {
            console.error("[Agent] Error while reporting a failed run:", cleanupError);
          } finally {
            // Resolve, not reject: the run happened and its rows persist below.
            // The error still marks the root span so the trace reads as failed.
            resolve({ persister, error });
          }
        },
        onDone: async () => {
          try {
            // Backstop: a completed run must leave nothing parked behind.
            decisions.releaseSession(sessionId, RUN_ENDED_SKIP_REASON);
          } catch (cleanupError) {
            console.error("[Agent] Error while completing a run:", cleanupError);
          } finally {
            resolve({ persister });
          }
        },
      });
    });

  try {
    const outcome = options.trace
      ? await withAgentTrace(options.trace, run, {
          recordOutput: ({ persister }) => persister.finalText() || undefined,
          // The root span's exception and status message are read by anyone
          // who can open the trace, so the raw provider/agent error stays in
          // the server log and only the sanitised form the SSE frame carries
          // is recorded here.
          runError: ({ error }) => (error ? new Error(publicErrorMessage(error)) : undefined),
        })
      : { value: await run(), trace: "disabled" as const };
    const { persister, error } = outcome.value;

    // Flush the trailing text segment (or the usage-only / error row) —
    // stamped with this turn's trace outcome — and wait for all rows to
    // land, with the usage accumulated so far so a failed run's tokens still
    // count toward the run meters. Runs once here, after the run resolves,
    // rather than inside onDone/onError. Same contract as the handlers: the
    // release in the finally below is owed even if the flush throws.
    try {
      const tokenUsage = await usageAccumulator.toTokenUsage(options.isByok);
      // When tracing is off, pass no trace argument at all: finish()'s
      // `!trace` gate must see undefined, not a present-but-inert object, or a
      // tool-only turn with the flag off would gain an extra empty assistant
      // row that main never writes (byte-identical row set with the flag off).
      await persister.finish(
        tokenUsage,
        outcome.trace === "disabled" || !options.trace
          ? undefined
          : { traceId: options.trace.traceId, status: outcome.trace },
      );
      if (options.trace && outcome.trace !== "disabled") {
        await stream.writeSSE({
          event: "trace",
          data: JSON.stringify({ status: outcome.trace, traceId: options.trace.traceId }),
        });
      }
      if (!error) {
        console.log(`[Agent] Done. Run persisted for session ${sessionId}`);
        // Awaited so the terminal event is flushed before the stream closes.
        await stream.writeSSE({ event: "done", data: "{}" });
      }
    } catch (cleanupError) {
      console.error("[Agent] Error while completing a run:", cleanupError);
    }
  } finally {
    decisions.unregisterChannel(sessionId, channel);
    releaseRun(sessionId);
  }
}
