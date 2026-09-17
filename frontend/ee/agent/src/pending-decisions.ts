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

/**
 * Bounds on what may be parked at once. A session runs one prompt at a time
 * and the agent loop awaits each call's policy hook before preparing the
 * next, so one parked decision per session is the reachable maximum; the
 * service-wide cap keeps a crowd of parked sessions from holding an
 * unbounded set of args, resolvers and timers. Past either bound the hook
 * fails closed (see ParkRefusedError) instead of parking.
 */
export const MAX_PARKED_PER_SESSION = 1;
export const MAX_PARKED_TOTAL = 200;

/** Cap on remembered decided ids (for 409s on double-decides). */
const MAX_DECIDED_IDS = 500;

/** Cap on buffered decline details awaiting their tool result (see takeDecline). */
const MAX_DECLINES = 500;

export type DecisionAction = "create" | "skip" | "revise";

/**
 * The registry's approval classes a park can carry. A confirm park (creates
 * and updates) takes create, skip or revise; an approval park (deletes) takes
 * only create or skip — a revise on it settles as a skip, since a delete is
 * never re-proposed from typed changes.
 */
export type ParkApprovalClass = "confirm" | "approval";

/** What a parked hook receives when its decision resolves. */
export type DecisionOutcome =
  | { action: "create" }
  | { action: "skip"; reason: string }
  | { action: "revise"; text: string };

/**
 * Structured details stamped onto a declined proposal's tool result — the
 * panel's contract for labeling the outcome (skipped vs revised) without
 * inferring it from an error landing on a pending step. The loop's block path
 * can only carry text, so the run stream reads these via takeDecline and
 * rewrites the surfaced result's (empty) details with them.
 */
export interface ProposalDeclinedDetails {
  kind: "proposal_declined";
  outcome: "skipped" | "revised";
  /** The user's requested changes (outcome "revised" only). */
  text?: string;
}

/** The `confirmation_pending` SSE event payload — the panel's contract. */
export interface ConfirmationPendingEvent {
  type: "confirmation_pending";
  decisionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** How the panel renders the card: a confirm card, or the destructive
   *  approval card whose only answers are the button and skip. */
  approvalClass: ParkApprovalClass;
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
    `This ${toolName} call was NOT executed — the user chose to skip it. ` +
    `Do not retry it; acknowledge the skip and continue.`
  );
}

export function revisionReason(text: string): string {
  return (
    `This tool call was NOT executed. The user wants changes: ${text}\n` +
    `Propose the call again with those changes applied.`
  );
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

export const SESSION_PARK_LIMIT_REASON =
  "This proposal was not parked: this session already has a proposal waiting for a decision. " +
  "The call was not performed; wait for that decision, then propose again if still needed.";

export const GLOBAL_PARK_LIMIT_REASON =
  "This proposal was not parked: the service is holding as many pending proposals as it can. " +
  "The call was not performed; try again shortly.";

/** Thrown by park when a bound would be exceeded; the reason is narratable as-is. */
export class ParkRefusedError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ParkRefusedError";
  }
}

interface PendingEntry {
  decisionId: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  approvalClass: ParkApprovalClass;
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
  /**
   * session + toolCallId → decline details for tool results the loop is about
   * to surface as blocked-call errors. Consumed (once) by the run stream when
   * the matching tool_execution_end passes through; capped FIFO so entries
   * orphaned by a run dying mid-call cannot accumulate.
   *
   * Keyed by session as well as tool call because this store is one process-wide
   * singleton and tool-call ids come from the model provider — some number them
   * per run ("call_0"), so two sessions in flight at once can hold the same id.
   * On a bare toolCallId key, one session's tool result would consume another's
   * decline and carry its revision text into a different user's stream, durable
   * row and model context.
   */
  private readonly declines = new Map<string, ProposalDeclinedDetails>();

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
   * Why a park for this session would be refused right now, or null when it
   * fits within both bounds.
   */
  parkRefusal(sessionId: string): string | null {
    if (this.pendingCount(sessionId) >= MAX_PARKED_PER_SESSION) return SESSION_PARK_LIMIT_REASON;
    if (this.pending.size >= MAX_PARKED_TOTAL) return GLOBAL_PARK_LIMIT_REASON;
    return null;
  }

  /**
   * Park a tool call until a decision arrives. The returned promise always
   * resolves (never rejects): a timeout backstop skips the call after
   * DECISION_TIMEOUT_MS even if every other release path is missed.
   *
   * Throws ParkRefusedError when the session or the service already holds
   * as many parked decisions as the bounds allow; nothing is registered then.
   */
  park(input: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    args: unknown;
    /** Defaults to confirm; an approval park settles a revise as a skip. */
    approvalClass?: ParkApprovalClass;
  }): {
    decisionId: string;
    outcome: Promise<DecisionOutcome>;
  } {
    const refusal = this.parkRefusal(input.sessionId);
    if (refusal !== null) throw new ParkRefusedError(refusal);
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
        approvalClass: input.approvalClass ?? "confirm",
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
   *
   * A revise on an approval-class park (a delete) settles as a skip: there is
   * no revise-by-typing for a destructive call, so typed text can only mean
   * "not this", never "this, changed".
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
        : request.action === "revise" && entry.approvalClass !== "approval"
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

  /**
   * The declines key. A NUL separator cannot occur in either id, so no pair of
   * distinct (session, tool call) values can collide on one key.
   */
  private static declineKey(sessionId: string, toolCallId: string): string {
    return `${sessionId}\u0000${toolCallId}`;
  }

  /**
   * Consume the decline details recorded for a tool call in this session, if
   * any. The session must match the one the decline was recorded under: a
   * concurrent session reusing the same provider tool-call id must not consume
   * it, and must not be labeled with its outcome.
   */
  takeDecline(sessionId: string, toolCallId: string): ProposalDeclinedDetails | undefined {
    const key = PendingDecisions.declineKey(sessionId, toolCallId);
    const details = this.declines.get(key);
    if (details !== undefined) this.declines.delete(key);
    return details;
  }

  private settle(entry: PendingEntry, outcome: DecisionOutcome): void {
    clearTimeout(entry.timeout);
    this.pending.delete(entry.decisionId);
    if (this.pendingCount(entry.sessionId) === 0) {
      this.stopHeartbeat(entry.sessionId);
    }
    if (outcome.action !== "create") {
      this.declines.set(PendingDecisions.declineKey(entry.sessionId, entry.toolCallId), {
        kind: "proposal_declined",
        outcome: outcome.action === "revise" ? "revised" : "skipped",
        ...(outcome.action === "revise" ? { text: outcome.text } : {}),
      });
      if (this.declines.size > MAX_DECLINES) {
        const oldest = this.declines.keys().next().value;
        if (oldest !== undefined) this.declines.delete(oldest);
      }
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
