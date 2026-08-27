import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TokenUsageData, TurnAttribution } from "./session.js";

/** Signature of SessionManager.appendMessage — injected so the persister is testable. */
export type AppendMessageFn = (
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  tokenUsage?: TokenUsageData,
  attribution?: TurnAttribution,
) => Promise<unknown>;

/**
 * Mirrors a run's agent events into durable AIMessage rows so reloaded
 * history matches what the live stream rendered:
 *
 * - assistant text is flushed as a segment row at every tool boundary (and at
 *   run end), preserving text → tool → text interleaving;
 * - each tool call becomes a `tool_step` row whose metadata carries the args
 *   captured at start and the result/isError from end;
 * - thinking deltas go to segment metadata, never into content;
 * - the run's token usage is attached to the final text segment.
 *
 * Inserts are chained: the SSE event callback is synchronous, so naive
 * fire-and-forget writes could land out of order and scramble history. A
 * failed insert is logged and skipped — later rows still persist.
 */
export class StreamPersister {
  private chain: Promise<void> = Promise.resolve();
  private text = "";
  private thinking = "";
  /** args by toolCallId, captured at tool_execution_start (end events lack args) */
  private pendingToolArgs = new Map<string, Record<string, unknown>>();

  constructor(private readonly append: AppendMessageFn) {}

  onEvent(event: AgentEvent): void {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent as { type?: string; delta?: string };
      if (delta?.type === "text_delta" && delta.delta) this.text += delta.delta;
      if (delta?.type === "thinking_delta" && delta.delta) this.thinking += delta.delta;
      return;
    }

    if (event.type === "tool_execution_start") {
      this.pendingToolArgs.set(event.toolCallId, event.args ?? {});
      this.flushTextSegment();
      return;
    }

    if (event.type === "tool_execution_end") {
      const args = this.pendingToolArgs.get(event.toolCallId) ?? {};
      this.pendingToolArgs.delete(event.toolCallId);
      this.enqueue("tool_step", "", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args,
        result: event.result,
        isError: event.isError,
      });
    }
  }

  /** Flush the trailing text segment (with the run's usage) and wait for all inserts. */
  async finish(tokenUsage?: TokenUsageData): Promise<void> {
    this.flushTextSegment(tokenUsage);
    await this.chain;
  }

  private flushTextSegment(tokenUsage?: TokenUsageData): void {
    // A run can end at a tool boundary with no trailing text; its usage must
    // still land in a row, else the run escapes run counting and billing.
    if (!this.text && !this.thinking && !tokenUsage) return;
    const content = this.text;
    const thinking = this.thinking;
    this.text = "";
    this.thinking = "";
    const metadata = {
      ...(thinking ? { thinking } : {}),
      // The cumulative session total only exists in stream events — persist it
      // with the final segment so the reloaded usage footer can show it.
      ...(tokenUsage?.totalTokens != null ? { totalTokens: tokenUsage.totalTokens } : {}),
    };
    this.enqueue(
      "assistant",
      content,
      Object.keys(metadata).length > 0 ? metadata : undefined,
      tokenUsage,
    );
  }

  private enqueue(
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
    tokenUsage?: TokenUsageData,
  ): void {
    this.chain = this.chain
      .then(async () => {
        await this.append(role, content, metadata, tokenUsage);
      })
      .catch((error) => {
        console.error(`[Agent] Failed to persist ${role} message:`, error);
      });
  }
}
