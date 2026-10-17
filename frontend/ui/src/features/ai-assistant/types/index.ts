import type { TraceStatus } from "@traceroot/core";

/**
 * A confirm-class write parked by the agent, waiting on the user. Present only
 * while the call is parked; the tool result (or a posted decision) clears it.
 * Never persisted — a parked call dies with the agent service, so a reloaded
 * transcript shows the plain running tool line instead.
 */
export interface PendingConfirmation {
  /** The parked decision's id — what the decisions endpoint is called with.
   *  A superseding confirmation_pending event replaces it in place. */
  decisionId: string;
  /** "approval" on a delete: the destructive card, whose only answers are
   *  its button and skip — a typed reply skips it. Absent means confirm,
   *  except on a delete, which the panel treats as approval regardless. */
  approvalClass?: "confirm" | "approval";
}

export interface ToolCallStep {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done" | "error";
  /** ClickHouse span id for this tool call, when the run was traced. */
  spanId?: string;
  /**
   * Capture-policy outcome on a persisted step (absent on the live stream,
   * which shows the result in full): why the result was not kept, whether
   * what was kept was cut, and how big the real output was.
   */
  withheld?: "not-allowlisted" | "budget" | null;
  truncated?: boolean;
  outputBytes?: number;
  /** Set while the call is parked awaiting the user's create/skip/revise
   *  decision (create and skip are the card's buttons; a typed reply revises). */
  pending?: PendingConfirmation;
  /** True when the call was declined as a skip (user's, or a server-side
   *  release) — the tool line notes it instead of reading as a failure. */
  skipped?: boolean;
  /** The user's requested changes, when the call was declined as a revision
   *  — the tool line notes "revised" with this text instead of "skipped". */
  revisedText?: string;
}

export interface AIMessage {
  id: string;
  role: "user" | "assistant" | "tool_step";
  content: string;
  timestamp: string;
  isStreaming?: boolean;
  thinking?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  // only set when role === "tool_step"
  toolStep?: ToolCallStep;
  /** Trace id for the run this assistant segment belongs to, when traced. */
  traceId?: string;
  /** Export status of `traceId` — a step's "Open span" only shows once it's "available". */
  traceStatus?: TraceStatus;
}

export interface AISession {
  id: string;
  projectId: string;
  title: string | null;
  status: string;
  createTime: string;
}

export interface AiTraceContext {
  traceId?: string;
  traceSessionId?: string;
}
