import { randomUUID } from "node:crypto";

/**
 * In-process registry of confirmation decisions the agent is parked on.
 *
 * When a confirm-class write is proposed in an attended session, the write
 * policy hook parks the tool call here and the run's SSE stream carries a
 * `confirmation_pending` event to the panel. The user's decision arrives via
 * the decisions endpoint and resolves the parked promise.
 *
 * Known limit (by design): state is in-process only. A service restart
 * abandons pending decisions — their runs die with the process, and any
 * later decide() for their ids returns "unknown" (a 404). Acceptable for a
 * taste gate; a durable store would be needed for multi-instance deploys.
 *
 * A parked promise that never resolves would hold an agent turn open
 * forever, so every exit path releases it: user decision, run error, run
 * completion, client disconnect, session deletion, and a timeout backstop.
 */

/** How long a parked decision waits before it is skipped automatically. */
export const DECISION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Heartbeat interval while a decision is parked. The stream is silent while
 * the agent waits, and intermediaries (notably undici's default 5-minute
 * bodyTimeout in the Next.js proxy's fetch) kill bodies that go idle — so we
 * write an SSE comment through the channel to keep bytes flowing.
 */
export const PARKED_HEARTBEAT_MS = 15_000;

/** Cap on remembered decided ids (for 409s on double-decides). */
const MAX_DECIDED_IDS = 500;

export type DecisionAction = "create" | "skip" | "revise";

/** What a parked hook receives when its decision resolves. */
export type DecisionOutcome =
  | { action: "create" }
  | { action: "skip"; reason: string }
  | { action: "revise"; text: string };

/** The `confirmation_pending` SSE event payload — the panel's contract. */
export interface ConfirmationPendingEvent {
  type: "confirmation_pending";
  decisionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/**
 * A live run's side of the stream: who is attended (empty userId means an
 * unattended/system session), how to emit an event, and how to keep the
 * connection warm while parked.
 */
export interface ConfirmationChannel {
  userId: string;
  emit: (event: ConfirmationPendingEvent) => void;
  keepalive: () => void;
}

export function userSkipReason(toolName: string): string {
  return (
    `The user chose to skip this proposed ${toolName} call. ` +
    `It was not performed; continue without it and do not retry it.`
  );
}

export function revisionReason(text: string): string {
  return `The user wants changes: ${text}`;
}

export const DECISION_TIMED_OUT_SKIP_REASON =
  "The user did not decide within the confirmation window, so the call was skipped. " +
  "It was not performed; continue without it and do not retry it.";

export const RUN_ERROR_SKIP_REASON =
  "The run failed before the user decided. The call was not performed.";

export const RUN_ENDED_SKIP_REASON =
  "The run ended before the user decided. The call was not performed.";

export const CLIENT_DISCONNECTED_SKIP_REASON =
  "The user's connection closed before they decided. The call was not performed.";

export const SESSION_DELETED_SKIP_REASON =
  "The session was deleted before the user decided. The call was not performed.";

interface PendingEntry {
  decisionId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  createdAt: number;
  resolve: (outcome: DecisionOutcome) => void;
  timeout: NodeJS.Timeout;
}

export class PendingDecisions {
  private readonly pending = new Map<string, PendingEntry>();
  /**
   * decisionId → sessionId for ids resolved by an explicit user decision —
   * a second decide from the same session is a conflict, while a foreign
   * session still sees "unknown" so ids cannot be probed across sessions.
   */
  private readonly decided = new Map<string, string>();
  private readonly channels = new Map<string, ConfirmationChannel>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();

  /** Register the live run's stream channel for a session (last one wins). */
  registerChannel(sessionId: string, channel: ConfirmationChannel): void {
    this.channels.set(sessionId, channel);
  }

  /** Remove the channel, but only if it is still this run's channel. */
  unregisterChannel(sessionId: string, channel: ConfirmationChannel): void {
    if (this.channels.get(sessionId) === channel) {
      this.channels.delete(sessionId);
      this.stopHeartbeat(sessionId);
    }
  }

  channelFor(sessionId: string): ConfirmationChannel | undefined {
    return this.channels.get(sessionId);
  }

  /**
   * Park a tool call until a decision arrives. The returned promise always
   * resolves (never rejects): a timeout backstop skips the call after
   * DECISION_TIMEOUT_MS even if every other release path is missed.
   */
  park(input: { sessionId: string; toolCallId: string; toolName: string; args: unknown }): {
    decisionId: string;
    outcome: Promise<DecisionOutcome>;
  } {
    const decisionId = randomUUID();
    const outcome = new Promise<DecisionOutcome>((resolve) => {
      const timeout = setTimeout(() => {
        this.releaseDecision(decisionId, DECISION_TIMED_OUT_SKIP_REASON);
      }, DECISION_TIMEOUT_MS);
      timeout.unref?.();
      this.pending.set(decisionId, {
        decisionId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: input.args,
        createdAt: Date.now(),
        resolve,
        timeout,
      });
    });
    this.startHeartbeat(input.sessionId);
    return { decisionId, outcome };
  }

  /**
   * Resolve a parked decision on the user's behalf. The sessionId must match
   * the one the decision was parked under — a mismatch is indistinguishable
   * from an unknown id so callers cannot probe other sessions' decisions.
   */
  decide(
    decisionId: string,
    sessionId: string,
    request: { action: DecisionAction; text?: string },
  ): "resolved" | "unknown" | "already_decided" {
    const entry = this.pending.get(decisionId);
    if (!entry || entry.sessionId !== sessionId) {
      return this.decided.get(decisionId) === sessionId ? "already_decided" : "unknown";
    }
    this.decided.set(decisionId, sessionId);
    if (this.decided.size > MAX_DECIDED_IDS) {
      const oldest = this.decided.keys().next().value;
      if (oldest !== undefined) this.decided.delete(oldest);
    }
    const outcome: DecisionOutcome =
      request.action === "create"
        ? { action: "create" }
        : request.action === "revise"
          ? { action: "revise", text: request.text ?? "" }
          : { action: "skip", reason: userSkipReason(entry.toolName) };
    this.settle(entry, outcome);
    return "resolved";
  }

  /** Internally skip one parked decision (timeout, failed emit). */
  releaseDecision(decisionId: string, reason: string): boolean {
    const entry = this.pending.get(decisionId);
    if (!entry) return false;
    this.settle(entry, { action: "skip", reason });
    return true;
  }

  /** Skip every parked decision for a session; returns how many were released. */
  releaseSession(sessionId: string, reason: string): number {
    let released = 0;
    for (const entry of [...this.pending.values()]) {
      if (entry.sessionId === sessionId) {
        this.settle(entry, { action: "skip", reason });
        released += 1;
      }
    }
    return released;
  }

  pendingCount(sessionId?: string): number {
    if (sessionId === undefined) return this.pending.size;
    let count = 0;
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) count += 1;
    }
    return count;
  }

  private settle(entry: PendingEntry, outcome: DecisionOutcome): void {
    clearTimeout(entry.timeout);
    this.pending.delete(entry.decisionId);
    if (this.pendingCount(entry.sessionId) === 0) {
      this.stopHeartbeat(entry.sessionId);
    }
    entry.resolve(outcome);
  }

  private startHeartbeat(sessionId: string): void {
    if (this.heartbeats.has(sessionId) || !this.channels.has(sessionId)) return;
    const interval = setInterval(() => {
      const channel = this.channels.get(sessionId);
      if (!channel || this.pendingCount(sessionId) === 0) {
        this.stopHeartbeat(sessionId);
        return;
      }
      try {
        channel.keepalive();
      } catch {
        // A dead stream must never take the heartbeat timer down with it.
      }
    }, PARKED_HEARTBEAT_MS);
    interval.unref?.();
    this.heartbeats.set(sessionId, interval);
  }

  private stopHeartbeat(sessionId: string): void {
    const interval = this.heartbeats.get(sessionId);
    if (interval !== undefined) {
      clearInterval(interval);
      this.heartbeats.delete(sessionId);
    }
  }
}

/** The service-wide registry instance. */
export const pendingDecisions = new PendingDecisions();
