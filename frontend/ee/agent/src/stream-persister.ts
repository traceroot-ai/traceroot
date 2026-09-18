import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { applyCapturePolicy } from "@traceroot/core/capture-policy";
import { agentCaptureInput } from "./capture-input.js";
import type { TokenUsageData } from "./session.js";

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
 *   captured at start and the result/isError from end — rows land in
 *   tool_execution_start order (what the live panel showed), not completion
 *   order, so parallel tool calls do not reorder on reload;
 * - args and results go through the capture policy (@traceroot/core/capture-policy):
 *   redacted, allow-listed output kept, bounded per step and per run; a
 *   structured value is capped leaf by leaf so a result's small `details`
 *   stay intact beside a large `content`, and what is cut is marked on the
 *   row (`truncated`, `withheld`, `outputBytes`);
 * - thinking deltas go to segment metadata, never into content;
 * - a failed run persists its error message as `runError` on the final
 *   segment's metadata, so reload shows the failure the live stream showed;
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
}

export class StreamPersister {
  private chain: Promise<void> = Promise.resolve();
  private text = "";
  private thinking = "";
  private runError: string | undefined;
  /** Whether the run produced anything at all (text, thinking, or a tool step) — see finish. */
  private produced = false;
  /** args by toolCallId, captured at tool_execution_start (end events lack args) */
  private pendingToolArgs = new Map<string, Record<string, unknown>>();
  private readonly captureState: { spentBytes: number };
  /** toolCallIds in tool_execution_start order — the order rows must persist in */
  private toolStartOrder: string[] = [];
  /** finished tool rows buffered until every earlier-started tool has finished */
  private completedToolRows = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly append: AppendMessageFn,
    options: StreamPersisterOptions = {},
  ) {
    this.captureState = options.state ?? { spentBytes: 0 };
  }

  onEvent(event: AgentEvent): void {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent as { type?: string; delta?: string };
      if (delta?.type === "text_delta" && delta.delta) {
        this.text += delta.delta;
        this.produced = true;
      }
      if (delta?.type === "thinking_delta" && delta.delta) {
        this.thinking += delta.delta;
        this.produced = true;
      }
      return;
    }

    if (event.type === "message_end") {
      const message = (event as { message?: { stopReason?: string; errorMessage?: string } })
        .message;
      if (message?.stopReason === "error") {
        this.recordError(message.errorMessage || "unknown error");
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      this.produced = true;
      this.pendingToolArgs.set(event.toolCallId, event.args ?? {});
      this.toolStartOrder.push(event.toolCallId);
      this.flushTextSegment();
      return;
    }

    if (event.type === "tool_execution_end") {
      const args = this.pendingToolArgs.get(event.toolCallId) ?? {};
      this.pendingToolArgs.delete(event.toolCallId);
      const captured = applyCapturePolicy(
        agentCaptureInput(event.toolName, args, event.result),
        this.captureState,
      );
      this.completedToolRows.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: captured.args,
        ...(captured.result !== undefined ? { result: captured.result } : {}),
        outputBytes: captured.outputBytes,
        ...(captured.truncated ? { truncated: true } : {}),
        ...(captured.withheld ? { withheld: captured.withheld } : {}),
        isError: event.isError,
      });
      this.flushCompletedToolRows();
    }
  }

  /**
   * Record a run-level failure so it persists with the final segment. The
   * first recorded message wins: a message_end's specific API error beats the
   * generic run-failed wrapper that follows it.
   */
  recordError(message: string): void {
    this.runError ??= message || "unknown error";
  }

  /** Flush the trailing text segment (with the run's usage) and wait for all inserts. */
  async finish(tokenUsage?: TokenUsageData): Promise<void> {
    // A tool that started but never ended (the run died mid-call) has no row;
    // drain the completed ones past it so they still land in start order.
    for (const toolCallId of this.toolStartOrder) {
      const row = this.completedToolRows.get(toolCallId);
      if (row) this.enqueue("tool_step", "", row);
    }
    this.toolStartOrder = [];
    this.completedToolRows.clear();
    this.pendingToolArgs.clear();
    // A run that died before its first completion (bad key, 401/429) reports
    // a model with zero tokens: persisting that usage would meter a run the
    // user never got. Tool-only and errored runs that did consume tokens stay
    // billable, as does a text-producing run whose provider omitted usage.
    // A positive cost is consumption too — a provider can price a turn
    // without reporting a token split, and dropping it would meter that run
    // at nothing.
    const consumedNothing =
      tokenUsage !== undefined &&
      tokenUsage.inputTokens === 0 &&
      tokenUsage.outputTokens === 0 &&
      tokenUsage.cost === 0;
    this.flushTextSegment(consumedNothing && !this.produced ? undefined : tokenUsage);
    await this.chain;
  }

  /** Enqueue finished tool rows from the head of the start order — a row waits
   *  until every tool started before it has finished, so persisted order is
   *  start order even when parallel calls complete out of order. */
  private flushCompletedToolRows(): void {
    while (this.toolStartOrder.length > 0) {
      const head = this.toolStartOrder[0];
      const row = this.completedToolRows.get(head);
      if (!row) return;
      this.completedToolRows.delete(head);
      this.toolStartOrder.shift();
      this.enqueue("tool_step", "", row);
    }
  }

  private flushTextSegment(tokenUsage?: TokenUsageData): void {
    // A run can end at a tool boundary with no trailing text; its usage must
    // still land in a row, else the run escapes run counting and billing.
    // Likewise a failed run must leave its error marker even with no text.
    if (!this.text && !this.thinking && !tokenUsage && !this.runError) return;
    const content = this.text;
    const thinking = this.thinking;
    const runError = this.runError;
    this.text = "";
    this.thinking = "";
    this.runError = undefined;
    const metadata = {
      ...(thinking ? { thinking } : {}),
      // The cumulative session total only exists in stream events — persist it
      // with the final segment so the reloaded usage footer can show it.
      ...(tokenUsage?.totalTokens != null ? { totalTokens: tokenUsage.totalTokens } : {}),
      // A failed run reloads as an error bubble instead of a silent no-answer.
      ...(runError ? { runError } : {}),
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
