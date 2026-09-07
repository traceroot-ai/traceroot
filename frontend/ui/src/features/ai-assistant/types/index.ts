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
}

export interface ToolCallStep {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done" | "error";
  /** Set while the call is parked awaiting the user's create/skip decision. */
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
