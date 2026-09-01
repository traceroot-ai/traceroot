import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TokenUsageData } from "./session.js";

/** Signature of SessionManager.appendMessage — injected so the persister is testable. */
export type AppendMessageFn = (
  role: string,
  content: string,
  metadata?: Record<string, unknown>,
  tokenUsage?: TokenUsageData,
) => Promise<void>;

/**
 * Cap applied independently to each serialized value persisted into a tool
 * row's metadata (each args entry, each result field). getSessionMessages
 * ships every row to the browser, so unbounded tool payloads would bloat
 * reloads; small structured values (e.g. a result's `details`) stay intact
 * because siblings are capped independently.
 */
export const METADATA_VALUE_BYTE_CAP = 8 * 1024;

const TRUNCATION_PREVIEW_CHARS = 256;

/**
 * Replaces a metadata value whose serialization exceeds
 * METADATA_VALUE_BYTE_CAP. Consumers detect truncation by `truncated: true`
 * where the original value would have been.
 */
export interface TruncatedValue {
  truncated: true;
  /** Serialized UTF-8 byte length of the original value. */
  bytes: number;
  /** The first ~256 characters of the original (raw string, or its JSON). */
  preview: string;
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  } catch {
    return "[unserializable]";
  }
}

function serializedBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    // circular or otherwise unserializable — the row insert would choke on it
    return null;
  }
}

function truncationMarker(value: unknown, bytes: number): TruncatedValue {
  return {
    truncated: true,
    bytes,
    preview: safeStringify(value).slice(0, TRUNCATION_PREVIEW_CHARS),
  };
}

/**
 * Bound a metadata value to METADATA_VALUE_BYTE_CAP. An oversized object or
 * array first has each entry bounded independently — so one huge field (a
 * verbose result `content`) is replaced while small siblings (structured
 * `details`) survive verbatim — and is replaced whole only if it still
 * exceeds the cap afterwards.
 */
function boundMetadataValue(value: unknown): unknown {
  const bytes = serializedBytes(value);
  if (bytes === null) return truncationMarker(value, 0);
  if (bytes <= METADATA_VALUE_BYTE_CAP) return value;

  let bounded: unknown = value;
  if (Array.isArray(value)) {
    bounded = value.map(boundMetadataValue);
  } else if (typeof value === "object" && value !== null) {
    bounded = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, boundMetadataValue(v)]),
    );
  }
  const boundedBytes = serializedBytes(bounded);
  if (boundedBytes !== null && boundedBytes <= METADATA_VALUE_BYTE_CAP) return bounded;
  return truncationMarker(value, bytes);
}

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
 * - oversized args/result values are bounded (see METADATA_VALUE_BYTE_CAP);
 * - thinking deltas go to segment metadata, never into content;
 * - a failed run persists its error message as `runError` on the final
 *   segment's metadata, so reload shows the failure the live stream showed;
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
  private runError: string | undefined;
  /** args by toolCallId, captured at tool_execution_start (end events lack args) */
  private pendingToolArgs = new Map<string, Record<string, unknown>>();
  /** toolCallIds in tool_execution_start order — the order rows must persist in */
  private toolStartOrder: string[] = [];
  /** finished tool rows buffered until every earlier-started tool has finished */
  private completedToolRows = new Map<string, Record<string, unknown>>();

  constructor(private readonly append: AppendMessageFn) {}

  onEvent(event: AgentEvent): void {
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent as { type?: string; delta?: string };
      if (delta?.type === "text_delta" && delta.delta) this.text += delta.delta;
      if (delta?.type === "thinking_delta" && delta.delta) this.thinking += delta.delta;
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
      this.pendingToolArgs.set(event.toolCallId, event.args ?? {});
      this.toolStartOrder.push(event.toolCallId);
      this.flushTextSegment();
      return;
    }

    if (event.type === "tool_execution_end") {
      const args = this.pendingToolArgs.get(event.toolCallId) ?? {};
      this.pendingToolArgs.delete(event.toolCallId);
      this.completedToolRows.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: boundMetadataValue(args),
        result: boundMetadataValue(event.result),
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
    this.flushTextSegment(tokenUsage);
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
      .then(() => this.append(role, content, metadata, tokenUsage))
      .catch((error) => {
        console.error(`[Agent] Failed to persist ${role} message:`, error);
      });
  }
}
