import { describe, expect, it } from "vitest";
import { getSystemPrompt } from "../prompts/system.js";
import type {
  CaptureContext,
  ContentCaptureKind,
  ContentCaptureValue,
} from "@traceroot-ai/traceroot";
import { captureLlmContent as capture, LLM_IO_CAP, TRUNCATED_ATTRIBUTE } from "../llm-content.js";

/** The capture context of the last call: what the capture asked to set on the span. */
let ctx: CaptureContext = { attributes: {} };
function captureLlmContent(kind: ContentCaptureKind, value: ContentCaptureValue) {
  ctx = { attributes: {} };
  return capture(kind, value, ctx);
}

const user = { role: "user", content: "Where is order A-2002?" };
const assistantWithCall = {
  role: "assistant",
  content: [
    { type: "text", text: "Let me check." },
    { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "cat /workspace/notes" } },
  ],
};
const bashResult = {
  role: "toolResult",
  toolCallId: "tc1",
  toolName: "bash",
  content: [{ type: "text", text: "DB_PASSWORD=hunter2\nlots of repo content" }],
  isError: false,
};
const downloadResult = {
  role: "toolResult",
  toolCallId: "tc2",
  toolName: "download_traces",
  content: [
    {
      type: "text",
      text: '{"spans":[{"name":"x","api_key":"sk-live-abcdefghijklmnopqrstuvwxyz"}]}',
    },
  ],
  isError: false,
};

describe("captureLlmContent", () => {
  it("records nothing for the SDK's own agent span: the self-trace root already carries prompt and answer", () => {
    expect(captureLlmContent("agent_input", { text: "prompt" })).toBeUndefined();
    expect(captureLlmContent("agent_output", { messages: [user] })).toBeUndefined();
  });

  it("renders a model call's input — the messages, tool results under the allowlist — without the system prompt", () => {
    const out = captureLlmContent("llm_input", {
      systemPrompt: "You are the RCA agent.",
      messages: [user, assistantWithCall, bashResult, downloadResult],
    })!;
    const rendered = JSON.parse(out) as Array<Record<string, unknown>>;
    // The system prompt is not part of the per-call record (it is on the root).
    expect(rendered.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(rendered[1]).toMatchObject({
      role: "assistant",
      content: "Let me check.",
      tool_calls: [{ id: "tc1", name: "bash", arguments: { command: "cat /workspace/notes" } }],
    });
    // bash is not allow-listed: the note the tool span carries, never the text.
    expect(rendered[2]).toMatchObject({ role: "tool", tool: "bash", tool_call_id: "tc1" });
    expect(String(rendered[2].content)).toMatch(
      /^Output not stored after the run \(\d+ bytes returned\)\. Shell, file and git output/,
    );
    expect(String(rendered[2].content)).not.toContain("[withheld");
    expect(out).not.toContain("hunter2");
    // download_traces is allow-listed: kept, but redacted.
    expect(rendered[3]).toMatchObject({ role: "tool", tool: "download_traces" });
    expect(String(rendered[3].content)).toContain('"name":"x"');
    expect(out).not.toContain("sk-live-abcdefghijklmnopqrstuvwxyz");
    expect(out).toContain("[REDACTED]");
  });

  it("renders a text reply as plain text and a tool-calling reply with its calls, redacted", () => {
    expect(
      captureLlmContent("llm_output", {
        message: { role: "assistant", content: [{ type: "text", text: "Use ORDERS.get(id)." }] },
      }),
    ).toBe("Use ORDERS.get(id).");
    const withCall = captureLlmContent("llm_output", { message: assistantWithCall })!;
    expect(JSON.parse(withCall)).toMatchObject({
      role: "assistant",
      tool_calls: [{ name: "bash" }],
    });
    const leaky = captureLlmContent("llm_output", {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }],
      },
    })!;
    expect(leaky).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("bounds each span's content to LLM_IO_CAP bytes after redacting, whatever the script", () => {
    for (const text of [
      "x".repeat(LLM_IO_CAP * 2),
      "汉".repeat(LLM_IO_CAP),
      "😀".repeat(LLM_IO_CAP),
    ]) {
      const out = captureLlmContent("llm_input", { messages: [{ role: "user", content: text }] })!;
      expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(LLM_IO_CAP);
      expect(out.endsWith("…")).toBe(true);
      // The cut is on the span as an attribute, not only as a marker in the text (design B7).
      expect(ctx.attributes).toEqual({ [TRUNCATED_ATTRIBUTE]: true });
    }
  });

  it("marks nothing on a span whose content fit", () => {
    captureLlmContent("llm_input", { messages: [user] });
    expect(ctx.attributes).toEqual({});
    captureLlmContent("llm_output", { message: assistantWithCall });
    expect(ctx.attributes).toEqual({});
  });

  it("keeps the latest turn with the real system prompt in play", () => {
    // The real prompt alone is over the 16 KB cap; rendered first, it used to
    // be all any LLM span carried. It is passed but must not crowd out the turn.
    const systemPrompt = getSystemPrompt({ projectId: "p1", traceId: "a".repeat(32) });
    expect(Buffer.byteLength(systemPrompt, "utf8")).toBeGreaterThan(LLM_IO_CAP);
    const out = captureLlmContent("llm_input", {
      systemPrompt,
      messages: [
        { role: "user", content: "why did the stock tool fail?" },
        { role: "assistant", content: [{ type: "text", text: "Let me look." }] },
        {
          role: "toolResult",
          toolName: "download_traces",
          toolCallId: "tc9",
          content: [{ type: "text", text: "Downloaded 1/1 traces" }],
        },
      ],
    })!;
    expect(out).toContain("why did the stock tool fail?");
    expect(out).toContain("Downloaded 1/1 traces");
    expect(out).not.toContain("You are a debugging assistant");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(LLM_IO_CAP);
  });

  it("drops the oldest messages first when the conversation is over the cap, and says how many", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: "user",
      content: `message ${i} ` + "x".repeat(1_000),
    }));
    const out = captureLlmContent("llm_input", { messages })!;
    const rendered = JSON.parse(out.replace(/…$/, "")) as Array<{ role: string; content: string }>;
    expect(rendered[0].role).toBe("omitted");
    expect(rendered[0].content).toMatch(/^\[\d+ earlier messages omitted\]$/);
    expect(rendered[rendered.length - 1].content.startsWith("message 39 ")).toBe(true);
    expect(out).not.toContain("message 0 ");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(LLM_IO_CAP);
    // Dropping whole messages is a cut too.
    expect(ctx.attributes).toEqual({ [TRUNCATED_ATTRIBUTE]: true });
  });

  it("redacts a credential inside a message's own text — user, system, assistant — before serialising", () => {
    const pasted = JSON.stringify({ password: "review-dummy-secret", note: "plain" });
    const input = captureLlmContent("llm_input", {
      systemPrompt: `Config: ${pasted}`,
      messages: [
        { role: "user", content: pasted },
        { role: "assistant", content: [{ type: "text", text: pasted }] },
      ],
    })!;
    expect(input).not.toContain("review-dummy-secret");
    expect(input).toContain("plain");
    const output = captureLlmContent("llm_output", {
      message: {
        role: "assistant",
        content: [
          { type: "text", text: pasted },
          { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    })!;
    expect(output).not.toContain("review-dummy-secret");
    expect(output).toContain('"command":"ls"');
  });

  it("redacts credential-shaped keys inside a tool call's arguments, on the output and the input side", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "t1",
          name: "bash",
          arguments: {
            apiToken: "review-dummy-secret",
            nested: { dbPassword: 4242, keep: "plain" },
          },
        },
      ],
    };
    const output = captureLlmContent("llm_output", { message })!;
    const input = captureLlmContent("llm_input", { messages: [message] })!;
    for (const out of [output, input]) {
      expect(out).not.toContain("review-dummy-secret");
      expect(out).not.toContain("4242");
      expect(out).toContain('"apiToken":"[REDACTED]"');
      expect(out).toContain('"dbPassword":"[REDACTED]"');
      expect(out).toContain('"keep":"plain"');
    }
  });

  it("records nothing when the host could not supply the messages", () => {
    expect(captureLlmContent("llm_input", {})).toBeUndefined();
    expect(captureLlmContent("llm_output", {})).toBeUndefined();
  });
});
