export interface ToolCallStep {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done" | "error";
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
