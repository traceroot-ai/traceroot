/**
 * Offline check of what the agent sends to DeepSeek: every request uses a current model with
 * thinking disabled, so a tool-calling turn and a later turn on the same agent stay valid
 * without passing back reasoning_content.
 *
 * Run: pnpm test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

type Message = {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: { id: string; function: { name: string; arguments: string } }[];
  reasoning_content?: string;
};
type Body = {
  model: string;
  messages: Message[];
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: { type?: string };
};

const requests: Body[] = [];

// Stand-in for DeepSeek's Chat Completions, with its thinking-mode rule.
function reply(body: Body): Response {
  const error = (message: string) => Response.json({ error: { message } }, { status: 400 });
  if (!['deepseek-flash', 'deepseek-v4-pro'].includes(body.model)) return error('Model Not Exist');
  const thinking = body.thinking?.type !== 'disabled';
  const assistants = body.messages.filter((m) => m.role === 'assistant');
  if (thinking && body.tools && assistants.some((m) => !m.reasoning_content)) {
    return error('pass back reasoning_content');
  }

  const last = body.messages[body.messages.length - 1];
  const message: Record<string, unknown> = { role: 'assistant', content: null };
  if (thinking) message.reasoning_content = 'Let me think.';
  if (last.role === 'user') {
    const calls = last.content?.includes('weather')
      ? ['San Francisco', 'Tokyo'].map((city) => ['get_weather', { city }] as const)
      : [['get_stock_price', { symbol: 'NVDA' }] as const];
    message.tool_calls = calls.map(([name, args], i) => ({
      id: `call_${assistants.length}_${i}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }));
  } else {
    const results: string[] = [];
    for (const m of [...body.messages].reverse()) {
      if (m.role !== 'tool') break;
      results.unshift(m.content ?? '');
    }
    message.content = `Based on ${results.join(' | ')}`;
  }
  return Response.json({
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: body.model,
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

test('every request disables thinking, across two tool turns on one agent', async () => {
  // Before the import: agent.ts builds its client (and reads TraceRoot settings) at load time.
  process.env.DEEPSEEK_API_KEY = 'test';
  process.env.TRACEROOT_ENABLED = 'false';
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    assert.equal(url.host, 'api.deepseek.com');
    const body: Body = JSON.parse(String(init?.body));
    requests.push(body);
    return reply(body);
  };
  const { ReActAgent } = await import('./agent.js');

  const agent = new ReActAgent();
  const first = await agent.runTurn("What's the weather in San Francisco and Tokyo? Compare them.");
  const second = await agent.runTurn("What's NVDA stock price?");

  assert.equal(requests.length, 4); // (tool call, tool result -> answer) x 2 turns
  for (const body of requests) {
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.tool_choice, 'auto');
  }
  const [assistant, ...toolMessages] = requests[1].messages.slice(2, 5);
  assert.deepEqual(
    toolMessages.map((m) => m.tool_call_id),
    assistant.tool_calls?.map((c) => c.id),
  );
  assert.match(first, /foggy/);
  assert.match(second, /495\.2/);
  // The second turn carries the whole first turn, final answer included.
  const roles = requests[2].messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'tool', 'assistant', 'user']);
  assert.equal(requests[2].messages[5].content, first);
});
