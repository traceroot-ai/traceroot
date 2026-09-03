import type { Agent } from "@earendil-works/pi-agent-core";
import { runAgent } from "./agent.js";
import {
  CLIENT_DISCONNECTED_SKIP_REASON,
  pendingDecisions,
  RUN_ENDED_SKIP_REASON,
  RUN_ERROR_SKIP_REASON,
  type PendingDecisions,
} from "./pending-decisions.js";
import { StreamPersister } from "./stream-persister.js";
import { UsageAccumulator } from "./usage-accumulator.js";
import type { SessionManager } from "./session.js";

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

  // Mirrors the run into AIMessage rows (text segments, tool steps) so
  // reloaded history matches what the live stream rendered.
  const persister = new StreamPersister((role, content, metadata, tokenUsage) =>
    options.sessionManager.appendMessage(role, content, metadata, tokenUsage),
  );
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

  try {
    await new Promise<void>((resolve) => {
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
            const declined = decisions.takeDecline(event.toolCallId);
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
          console.error(`[Agent] ERROR:`, error.message);
          // A dead run can never deliver a decision — unpark before anything else.
          decisions.releaseSession(sessionId, RUN_ERROR_SKIP_REASON);
          // Awaited so the terminal event is flushed before the stream closes.
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: error.message }),
          });
          // Persist whatever the run produced before failing (text so far,
          // completed tool steps) plus a durable error marker, so reloaded
          // history shows the failure instead of a silent non-answer — with
          // the usage accumulated before the failure so those tokens still
          // count toward the run meters.
          persister.recordError(error.message);
          await persister.finish(await usageAccumulator.toTokenUsage(options.isByok));
          resolve();
        },
        onDone: async () => {
          // Backstop: a completed run must leave nothing parked behind.
          decisions.releaseSession(sessionId, RUN_ENDED_SKIP_REASON);
          const tokenUsage = await usageAccumulator.toTokenUsage(options.isByok);
          // Flush the trailing text segment and wait for all rows to land
          await persister.finish(tokenUsage);
          console.log(`[Agent] Done. Run persisted for session ${sessionId}`);
          // Awaited so the terminal event is flushed before the stream closes.
          await stream.writeSSE({ event: "done", data: "{}" });
          resolve();
        },
      });
    });
  } finally {
    decisions.unregisterChannel(sessionId, channel);
    releaseRun(sessionId);
  }
}
