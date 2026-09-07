import { proposalDeclined } from "./proposal-declined";
import type { AIMessage } from "../types";

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

/**
 * Metadata persisted on a tool_step row. The persister bounds each serialized
 * args/result value to a byte cap; an oversized value arrives replaced by a
 * `{ truncated: true, bytes, preview }` marker where it would have been —
 * check for `truncated: true` before treating a value as the tool's payload.
 */
interface ToolStepMetadata {
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
}

/** Metadata persisted on an assistant segment row. `runError` is set on the
 *  final segment of a run that failed — the live stream showed an error
 *  bubble, so reload must render one too. */
interface AssistantMetadata {
  thinking?: string;
  totalTokens?: number;
  runError?: string;
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
      // A declined proposal persists its outcome in the result's structured
      // details — reload labels the step (skipped / revised) exactly as the
      // live stream did instead of showing a plain failure.
      const declined = proposalDeclined(md.result);
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
          ...(declined?.outcome === "skipped" ? { skipped: true } : {}),
          ...(declined?.outcome === "revised" ? { revisedText: declined.text ?? "" } : {}),
        },
      });
      continue;
    }
    const md = m.metadata as AssistantMetadata | null | undefined;
    const runError = typeof md?.runError === "string" && md.runError ? md.runError : undefined;
    const usage = {
      ...(m.inputTokens != null ? { inputTokens: m.inputTokens } : {}),
      ...(m.outputTokens != null ? { outputTokens: m.outputTokens } : {}),
      ...(md?.totalTokens != null ? { totalTokens: md.totalTokens } : {}),
      ...(m.cost != null ? { costUsd: Number(m.cost) } : {}),
    };
    // A content-less assistant row is the usage carrier of a run that ended at
    // a tool boundary. The live stream pins usage on the last text bubble, so
    // fold it into the previous assistant bubble instead of rendering an
    // empty one — but only within the same run: stop at the user turn so a
    // carrier can never overwrite an earlier run's usage. A row carrying a
    // run error is never folded — the failure must stay visible.
    if (m.role === "assistant" && !m.content && !md?.thinking && runError === undefined) {
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
    // A persisted run failure renders like the live stream's error bubble,
    // after whatever partial text the run produced before failing.
    const errorLine = runError ? `Error: ${runError}` : "";
    const content = errorLine
      ? m.content
        ? `${m.content}\n\n${errorLine}`
        : errorLine
      : m.content;
    out.push({
      id: m.id,
      role: m.role as "user" | "assistant",
      content,
      timestamp: m.createTime,
      ...(md?.thinking ? { thinking: md.thinking } : {}),
      ...usage,
    });
  }
  return out;
}
