import type { TraceStatus } from "@/features/detectors/hooks/use-findings";

export interface ToolCallStep {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done" | "error";
  /** ClickHouse span id for this tool call, when the run was traced. */
  spanId?: string;
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
  /** Export status of `traceId` — "View trace" only shows once it's "available". */
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
