// What the self-trace records on the SDK's own spans for an agent run's prompts
// and completions. Handed to instrumentPiAgentCore as its captureContent
// function, so nothing the model saw or said lands on a span without going
// through the same redaction, tool allowlist and size bound the root span's
// I/O and the persisted tool I/O already go through.
import type {
  CaptureContext,
  ContentCaptureKind,
  ContentCaptureValue,
} from "@traceroot-ai/traceroot";
import { applyCapturePolicy, capText, redactValue } from "@traceroot/core/capture-policy";
import { agentCaptureInput } from "./capture-input.js";
import { withheldOutputText } from "@traceroot/core/capture-note";

/** Per-span bound, in UTF-8 bytes, on a model call's rendered input or output (spec B8): same as the root's. */
export const LLM_IO_CAP = 16_384;

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
  return (
    content
      .filter(
        (p): p is Part => typeof p === "object" && p !== null && (p as Part).type === "toolCall",
      )
      // The arguments take the same key-aware walk the tool span's args took:
      // a credential-shaped key (`apiToken`, `dbPassword`) is blanked here too,
      // or what the tool row withheld would come back verbatim in the model's
      // history, once per call that carries it.
      .map((p) => ({ id: p.id, name: p.name, arguments: redactValue(p.arguments) }))
  );
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
  // The agent's own allow-list applies here as it does to the tool span and
  // the persisted row, so a registry write tool's result reads the same in
  // all three places.
  const c = applyCapturePolicy(agentCaptureInput(toolName, undefined, textOf(message.content)), {
    spentBytes: 0,
  });
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

/**
 * Redact every text leaf of the rendered structure FIRST (a user message
 * that pastes a JSON config, a system prompt, an assistant's text beside
 * its tool calls), then serialise, then bound to LLM_IO_CAP bytes (marker
 * included, byte-safe). Redacting the serialised string instead would miss
 * the colon patterns once the inner quotes are escaped (review F5).
 */
function bounded(rendered: unknown): Cut {
  return capText(JSON.stringify(redactValue(rendered)), LLM_IO_CAP);
}

/** A capped text and whether the cap cut it — the cut is marked on the span. */
type Cut = { text: string; truncated: boolean };

/**
 * The conversation a model call was given, bounded from the OLD end: when
 * the rendered list is over the cap, the oldest messages are dropped and one
 * marker says how many, so the latest turn — the tool result the model is
 * reacting to, the user's newest message — is what the span keeps. The
 * byte-safe cut in `bounded` still applies to a single oversized message.
 */
function boundedNewest(rendered: Record<string, unknown>[]): Cut {
  const redacted = redactValue(rendered) as Record<string, unknown>[];
  let dropped = 0;
  let kept = redacted;
  let json = JSON.stringify(kept);
  while (Buffer.byteLength(json, "utf8") > LLM_IO_CAP && kept.length > 1) {
    dropped += 1;
    kept = redacted.slice(dropped);
    json = JSON.stringify([
      {
        role: "omitted",
        content: `[${dropped} earlier message${dropped === 1 ? "" : "s"} omitted]`,
      },
      ...kept,
    ]);
  }
  const cut = capText(json, LLM_IO_CAP);
  return { text: cut.text, truncated: cut.truncated || dropped > 0 };
}

/**
 * instrumentPiAgentCore's captureContent. The SDK's own AGENT span
 * (`Agent.prompt`) is not opened under the self-trace root at all
 * (agentSpan: 'unless-nested' in agent.ts); should one ever be — the SDK used
 * outside a run — it records nothing, since the run's prompt and final answer
 * sit on the root withAgentTrace owns. Each LLM span records the conversation
 * it was given (newest messages kept under the cap, tool results under the
 * allowlist; the system prompt is on the root, once) and the assistant
 * message it produced, both redacted and bounded.
 */
export function captureLlmContent(
  kind: ContentCaptureKind,
  value: ContentCaptureValue,
  ctx: CaptureContext,
): string | undefined {
  switch (kind) {
    case "llm_input": {
      if (!value.messages) return undefined;
      // The system prompt is not part of each call's record: it is the same
      // 17 KB on every call and alone exceeds the cap, so rendering it first
      // left every LLM span with a truncated prompt and no message at all
      // (review, 2026-09-16). The root span records it once.
      return marked(ctx, boundedNewest(value.messages.map((m) => renderMessage(m as Message))));
    }
    case "llm_output": {
      if (!value.message) return undefined;
      const rendered = renderMessage(value.message as Message);
      const text = typeof rendered.content === "string" ? rendered.content : null;
      // A text-only reply reads as plain text; a tool-calling one keeps its structure.
      return marked(
        ctx,
        "tool_calls" in rendered ? bounded(rendered) : capText(text ?? "", LLM_IO_CAP),
      );
    }
    default:
      return undefined;
  }
}

/**
 * The attribute a span carries when what it records was cut to fit: the
 * viewer and a query can key on it instead of scanning for a marker in the
 * text (design B7). Set by every capture that cuts — an LLM span's input or
 * output here, a tool span's args or result in agent.ts.
 */
export const TRUNCATED_ATTRIBUTE = "traceroot.truncated";

function marked(ctx: CaptureContext, cut: Cut): string {
  if (cut.truncated) ctx.attributes[TRUNCATED_ATTRIBUTE] = true;
  return cut.text;
}
