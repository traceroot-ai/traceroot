import type { AIMessage } from "../types";

export interface PersistedAIMessage {
  id: string;
  role: string;
  content: string;
  createTime: string;
  metadata?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cost?: string | number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapPersistedMessage(message: PersistedAIMessage): AIMessage {
  if (message.role === "tool") {
    const metadata = isRecord(message.metadata) ? message.metadata : {};
    const toolName = typeof metadata.toolName === "string" ? metadata.toolName : "unknown_tool";
    const toolCallId = typeof metadata.toolCallId === "string" ? metadata.toolCallId : message.id;
    const args = isRecord(metadata.args) ? metadata.args : {};
    const isError = metadata.isError === true;
    const result =
      typeof metadata.resultSummary === "string" ? metadata.resultSummary : message.content;

    return {
      id: message.id,
      role: "tool_step",
      content: "",
      timestamp: message.createTime,
      toolStep: {
        toolCallId,
        toolName,
        args,
        result,
        isError,
        status: isError ? "error" : "done",
      },
    };
  }

  const role = message.role === "user" ? "user" : "assistant";
  const costUsd =
    message.cost == null
      ? undefined
      : typeof message.cost === "number"
        ? message.cost
        : Number(message.cost);

  return {
    id: message.id,
    role,
    content: message.content,
    timestamp: message.createTime,
    inputTokens: message.inputTokens ?? undefined,
    outputTokens: message.outputTokens ?? undefined,
    costUsd: Number.isFinite(costUsd) ? costUsd : undefined,
  };
}
