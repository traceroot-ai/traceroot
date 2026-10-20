/**
 * Offline check of what the agent sends. The OpenAI path stays on Chat Completions
 * with reasoning_effort "none" and no sampling settings; the Claude path sends no
 * temperature, thinking config, budget_tokens, or forced tool_choice.
 *
 * Run: pnpm test
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { runAgent } from "./agent";

type Part = {
  type: string;
  text?: string;
  content?: string | { type: string; text: string }[];
};
type Body = {
  model: string;
  messages: { role: string; content: string | Part[] | null }[];
  tools?: { name?: string; function?: { name: string } }[];
  [key: string]: unknown;
};
type ToolOutput = { price?: number; result?: number };

const QUESTION =
  "NVDA is climbing. If it rises 10% from its current price, what would the new price be?";
const SAMPLING = [
  "temperature",
  "top_p",
  "top_k",
  "presence_penalty",
  "frequency_penalty",
];

const requests: { path: string; body: Body }[] = [];
const warnings: string[] = [];
const realFetch = globalThis.fetch;
const realWarn = console.warn;

function toolOutputs(body: Body): ToolOutput[] {
  const outputs: ToolOutput[] = [];
  for (const m of body.messages) {
    if (m.role === "tool" && typeof m.content === "string")
      outputs.push(JSON.parse(m.content));
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== "tool_result" || part.content === undefined) continue;
      const text =
        typeof part.content === "string" ? part.content : part.content[0].text;
      outputs.push(JSON.parse(text));
    }
  }
  return outputs;
}

// Stand-in for both APIs: look up NVDA, calculate the 10% rise, then answer.
function reply(host: string, body: Body): Response {
  const [price, calc] = toolOutputs(body);
  const call: [string, Record<string, string>] | null = !price
    ? ["getStockPrice", { symbol: "NVDA" }]
    : !calc
      ? ["calculate", { expression: `${price.price} * 1.1` }]
      : null;
  const text = `The new price would be ${calc?.result?.toFixed(2)}.`;
  const id = `call_${body.messages.length}`;

  if (host === "api.openai.com") {
    // GPT-6 Luna supports function calling in Chat Completions only at effort "none".
    if (body.reasoning_effort !== "none") {
      return Response.json(
        { error: { message: "function calling needs reasoning_effort none" } },
        { status: 400 },
      );
    }
    const message = call
      ? {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: call[0], arguments: JSON.stringify(call[1]) },
            },
          ],
        }
      : { role: "assistant", content: text };
    return Response.json({
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [
        { index: 0, message, finish_reason: call ? "tool_calls" : "stop" },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  }
  assert.equal(host, "api.anthropic.com");
  return Response.json({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: body.model,
    content: call
      ? [{ type: "tool_use", id, name: call[0], input: call[1] }]
      : [{ type: "text", text }],
    stop_reason: call ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  process.env.ANTHROPIC_API_KEY = "test";
  requests.length = 0;
  warnings.length = 0;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const body: Body = JSON.parse(String(init?.body));
    requests.push({ path: url.pathname, body });
    return reply(url.host, body);
  };
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

test("OpenAI agent sends its tools over Chat Completions with reasoning_effort none", async () => {
  process.env.AGENT_PROVIDER = "openai";
  const result = await runAgent({ question: QUESTION });

  assert.deepEqual(result.toolsUsed, ["getStockPrice", "calculate"]);
  assert.match(result.answer, /544\.72/);
  assert.equal(requests.length, 3);
  for (const { path, body } of requests) {
    assert.equal(path, "/v1/chat/completions");
    assert.equal(body.model, "gpt-6-luna");
    assert.equal(body.reasoning_effort, "none");
    assert.deepEqual(
      body.tools?.map((t) => t.function?.name),
      ["getStockPrice", "calculate"],
    );
    for (const key of SAMPLING) assert.ok(!(key in body), key);
  }
  assert.deepEqual(warnings, []);
});

test("Claude agent sends no temperature, thinking config, budget_tokens, or forced tool_choice", async () => {
  process.env.AGENT_PROVIDER = "anthropic";
  const result = await runAgent({ question: QUESTION });

  assert.deepEqual(result.toolsUsed, ["getStockPrice", "calculate"]);
  assert.match(result.answer, /544\.72/);
  assert.equal(requests.length, 3);
  for (const { path, body } of requests) {
    assert.equal(path, "/v1/messages");
    assert.equal(body.model, "claude-opus-5-5");
    for (const key of [...SAMPLING, "thinking"]) assert.ok(!(key in body), key);
    assert.ok(!JSON.stringify(body).includes("budget_tokens"));
    assert.doesNotMatch(
      JSON.stringify(body.tool_choice ?? null),
      /"type":"(any|tool)"/,
    );
  }
  assert.deepEqual(warnings, []);
});
