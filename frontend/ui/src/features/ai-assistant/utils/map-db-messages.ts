import type { AIMessage } from "../types";

/** AIMessage row as returned by GET /api/projects/:id/ai/sessions/:id/messages. */
export interface DbAiMessageRow {
  id: string;
  role: string;
  content: string;
  createTime: string;
  metadata?: unknown;
  // usage columns — set only on the final assistant segment of a run
  inputTokens?: number | null;
  outputTokens?: number | null;
  cost?: number | null;
}

interface ToolStepMetadata {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

/**
 * Convert persisted AIMessage rows into the bubble shapes the live stream
 * produces, so reloaded history renders identically: tool_step rows become
 * expandable tool bubbles (args/result from metadata), assistant rows pick
 * their thinking up from metadata.
 */
export function mapDbMessages(rows: DbAiMessageRow[]): AIMessage[] {
  return rows.map((m): AIMessage => {
    if (m.role === "tool_step") {
      const md = (m.metadata ?? {}) as ToolStepMetadata;
      return {
        id: m.id,
        role: "tool_step",
        content: "",
        timestamp: m.createTime,
        toolStep: {
          toolCallId: md.toolCallId ?? m.id,
          toolName: md.toolName ?? "unknown",
          args: md.args ?? {},
          result: md.result,
          isError: md.isError,
          status: md.isError ? "error" : "done",
        },
      };
    }
    const thinking = (m.metadata as { thinking?: string } | null | undefined)?.thinking;
    return {
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: m.createTime,
      ...(thinking ? { thinking } : {}),
      ...(m.inputTokens != null ? { inputTokens: m.inputTokens } : {}),
      ...(m.outputTokens != null ? { outputTokens: m.outputTokens } : {}),
      ...(m.cost != null ? { costUsd: m.cost } : {}),
    };
  });
}
