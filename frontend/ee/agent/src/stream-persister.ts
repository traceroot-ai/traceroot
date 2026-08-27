import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { applyCapturePolicy } from "@traceroot/core/capture-policy";
import type { TokenUsageData } from "./session.js";
import type { AgentTraceOutcome } from "./self-trace.js";

/**
 * How the persister writes a row — injected so it is testable. The route binds
 * the turn's attribution into it; the persister never decides attribution.
 */
export type AppendMessageFn = (
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  tokenUsage?: TokenUsageData,
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
export interface StreamPersisterOptions {
  /**
   * The capture-policy budget to charge (see applyCapturePolicy). Pass the
   * run's own accumulator — the one the SDK's captureToolIo hook charges for
   * spans — so rows and spans stop capturing together instead of each getting
   * a full budget. Omitted, the persister keeps a budget of its own.
   */
  state?: { spentBytes: number };
  /**
   * Resolves the OTel span id the instrumentation reported for each tool
   * call (by toolCallId), so a tool_step row can point at its span.
   */
  toolSpanIds?: () => Map<string, string> | undefined;
}

export class StreamPersister {
  private chain: Promise<void> = Promise.resolve();
  private text = "";
  private thinking = "";
  /** The most recent non-empty text segment — the answer the root span records as its output. */
  private lastText = "";
  /** args by toolCallId, captured at tool_execution_start (end events lack args) */
  private pendingToolArgs = new Map<string, Record<string, unknown>>();
  private readonly captureState: { spentBytes: number };

  constructor(
    private readonly append: AppendMessageFn,
    private readonly options: StreamPersisterOptions = {},
  ) {
    this.captureState = options.state ?? { spentBytes: 0 };
  }

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
      const captured = applyCapturePolicy(
        { toolName: event.toolName, args, result: event.result },
        this.captureState,
      );
      const spanId = this.options.toolSpanIds?.()?.get(event.toolCallId);
      this.enqueue("tool_step", "", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: captured.args,
        ...(captured.result !== undefined ? { result: captured.result } : {}),
        outputBytes: captured.outputBytes,
        ...(captured.truncated ? { truncated: true } : {}),
        ...(captured.withheld ? { withheld: captured.withheld } : {}),
        ...(spanId ? { spanId } : {}),
        isError: event.isError,
      });
    }
  }

  /** The final assistant text so far (trailing unflushed text, else the last flushed segment). */
  finalText(): string {
    return this.text || this.lastText;
  }

  /** Flush the trailing text segment (with the run's usage and trace outcome) and wait for all inserts. */
  async finish(
    tokenUsage?: TokenUsageData,
    trace?: { traceId: string; status: AgentTraceOutcome },
  ): Promise<void> {
    this.flushTextSegment(tokenUsage, trace);
    await this.chain;
  }

  private flushTextSegment(
    tokenUsage?: TokenUsageData,
    trace?: { traceId: string; status: AgentTraceOutcome },
  ): void {
    // A run can end at a tool boundary with no trailing text; its usage (and
    // trace outcome) must still land in a row, else they escape run counting
    // and the trace link this feature exists for.
    if (!this.text && !this.thinking && !tokenUsage && !trace) return;
    const content = this.text;
    const thinking = this.thinking;
    if (content) this.lastText = content;
    this.text = "";
    this.thinking = "";
    const metadata = {
      ...(thinking ? { thinking } : {}),
      // The cumulative session total only exists in stream events — persist it
      // with the final segment so the reloaded usage footer can show it.
      ...(tokenUsage?.totalTokens != null ? { totalTokens: tokenUsage.totalTokens } : {}),
      ...(trace ? { traceId: trace.traceId, traceStatus: trace.status } : {}),
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
