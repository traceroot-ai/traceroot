import type { AIMessage } from "../types";
import type { TraceStatus } from "@traceroot/core";

/** AIMessage row as returned by GET /api/projects/:id/ai/sessions/:id/messages. */
export interface DbAiMessageRow {
  id: string;
  role: string;
  content: string;
  createTime: string;
  metadata?: unknown;
  // usage columns — set only on the final assistant segment of a run.
  // cost is a Prisma Decimal, which serializes to a string over JSON.
  inputTokens?: number | null;
  outputTokens?: number | null;
  cost?: number | string | null;
}

interface ToolStepMetadata {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  spanId?: string;
}

/**
 * Convert persisted AIMessage rows into the bubble shapes the live stream
 * produces, so reloaded history renders identically: tool_step rows become
 * expandable tool bubbles (args/result from metadata), assistant rows pick
 * their thinking up from metadata.
 */
export function mapDbMessages(rows: DbAiMessageRow[]): AIMessage[] {
  const out: AIMessage[] = [];
  for (const m of rows) {
    if (m.role === "tool_step") {
      const md = (m.metadata ?? {}) as ToolStepMetadata;
      out.push({
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
          spanId: md.spanId,
        },
      });
      continue;
    }
    const md = m.metadata as
      | { thinking?: string; totalTokens?: number; traceId?: string; traceStatus?: TraceStatus }
      | null
      | undefined;
    const usage = {
      ...(m.inputTokens != null ? { inputTokens: m.inputTokens } : {}),
      ...(m.outputTokens != null ? { outputTokens: m.outputTokens } : {}),
      ...(md?.totalTokens != null ? { totalTokens: md.totalTokens } : {}),
      ...(m.cost != null ? { costUsd: Number(m.cost) } : {}),
      ...(md?.traceId != null ? { traceId: md.traceId } : {}),
      ...(md?.traceStatus != null ? { traceStatus: md.traceStatus } : {}),
    };
    // A content-less assistant row is the usage carrier of a run that ended at
    // a tool boundary. The live stream pins usage on the last text bubble, so
    // fold it into the previous assistant bubble instead of rendering an
    // empty one — but only within the same run: stop at the user turn so a
    // carrier can never overwrite an earlier run's usage.
    if (m.role === "assistant" && !m.content && !md?.thinking) {
      let prev: AIMessage | undefined;
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i].role === "user") break;
        if (out[i].role === "assistant") {
          prev = out[i];
          break;
        }
      }
      if (prev) {
        Object.assign(prev, usage);
        continue;
      }
    }
    out.push({
      id: m.id,
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: m.createTime,
      ...(md?.thinking ? { thinking: md.thinking } : {}),
      ...usage,
    });
  }
  return out;
}
