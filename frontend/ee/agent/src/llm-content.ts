// What the self-trace records on the SDK's own spans for an agent run's prompts
// and completions. Handed to instrumentPiAgentCore as its captureContent
// function, so nothing the model saw or said lands on a span without going
// through the same redaction, tool allowlist and size bound the root span's
// I/O and the persisted tool I/O already go through.
import type { ContentCaptureKind, ContentCaptureValue } from "@traceroot-ai/traceroot";
import { applyCapturePolicy, redactSecrets } from "@traceroot/core/capture-policy";
import { withheldOutputText } from "@traceroot/core/capture-note";

/** Per-span bound on a model call's rendered input or output (spec B8): same as the root's. */
export const LLM_IO_CAP = 16_384;

const TRUNCATION_MARKER = "…";

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };
type Message = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is Part => typeof p === "object" && p !== null && (p as Part).type === "text")
    .map((p) => p.text ?? "")
    .join("");
}

function toolCallsOf(content: unknown): Array<{ id?: string; name?: string; arguments?: unknown }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (p): p is Part => typeof p === "object" && p !== null && (p as Part).type === "toolCall",
    )
    .map((p) => ({ id: p.id, name: p.name, arguments: p.arguments }));
}

/**
 * A tool result as the model saw it, under the tool allowlist: an allow-listed
 * tool's text is kept (redacted, capped per step), anything else becomes the
 * same reader-facing note the tool span and the persisted step carry, so what
 * the policy hid at the tool boundary stays hidden when the model was fed it.
 * A fresh budget per part: LLM spans are bounded per span (LLM_IO_CAP), not
 * charged to the run's tool budget (decided 2026-09-14).
 */
function renderToolResult(message: Message): Record<string, unknown> {
  const toolName = message.toolName ?? "tool";
  const c = applyCapturePolicy(
    { toolName, args: undefined, result: textOf(message.content) },
    { spentBytes: 0 },
  );
  return {
    role: "tool",
    tool: toolName,
    tool_call_id: message.toolCallId,
    ...(message.isError ? { is_error: true } : {}),
    content:
      c.result === undefined
        ? withheldOutputText(c)
        : typeof c.result === "string"
          ? c.result
          : JSON.stringify(c.result),
  };
}

function renderMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case "user":
      return { role: "user", content: textOf(message.content) };
    case "assistant": {
      const toolCalls = toolCallsOf(message.content);
      return {
        role: "assistant",
        content: textOf(message.content) || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
    }
    case "toolResult":
      return renderToolResult(message);
    default:
      // Bash executions, compaction summaries and other framework messages carry
      // nothing the trace needs; keep only that they were there.
      return { role: message.role ?? "unknown" };
  }
}

/** Redact, then bound: a cut before the redaction could split a token and defeat the pattern. */
function bounded(text: string): string {
  const redacted = redactSecrets(text);
  return redacted.length > LLM_IO_CAP
    ? `${redacted.slice(0, LLM_IO_CAP)}${TRUNCATION_MARKER}`
    : redacted;
}

/**
 * instrumentPiAgentCore's captureContent. The SDK's own AGENT span
 * (`Agent.prompt`) records nothing: the run's prompt and final answer already
 * sit on the self-trace root withAgentTrace owns, and a second copy would only
 * double the bytes. Each LLM span records the conversation it was given (system
 * prompt first, tool results under the allowlist) and the assistant message it
 * produced, both redacted and bounded.
 */
export function captureLlmContent(
  kind: ContentCaptureKind,
  value: ContentCaptureValue,
): string | undefined {
  switch (kind) {
    case "llm_input": {
      if (!value.messages) return undefined;
      const rendered = [
        ...(value.systemPrompt ? [{ role: "system", content: value.systemPrompt }] : []),
        ...value.messages.map((m) => renderMessage(m as Message)),
      ];
      return bounded(JSON.stringify(rendered));
    }
    case "llm_output": {
      if (!value.message) return undefined;
      const rendered = renderMessage(value.message as Message);
      const text = typeof rendered.content === "string" ? rendered.content : null;
      // A text-only reply reads as plain text; a tool-calling one keeps its structure.
      return bounded("tool_calls" in rendered ? JSON.stringify(rendered) : (text ?? ""));
    }
    default:
      return undefined;
  }
}
