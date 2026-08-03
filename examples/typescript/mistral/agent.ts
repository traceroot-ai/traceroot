/**
 * Mistral ReAct Agent — TraceRoot Observability
 *
 * A ReAct-style tool-calling agent built on the official @mistralai/mistralai
 * v2 SDK and instrumented with TraceRoot.
 *
 * Auto-instrumentation for the Mistral SDK is tracked in
 * https://github.com/traceroot-ai/traceroot/issues/739 — until that lands in
 * @traceroot-ai/traceroot, the `tracedComplete()` helper in ./traced-mistral.ts
 * wraps `mistral.chat.complete` and emits the same OpenInference span attributes
 * a future auto-instrumentor would emit (model, token counts, input/output,
 * finish reasons), so the trace shape stays correct today and migration is a
 * one-line swap later.
 *
 * Env vars required: MISTRAL_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';
import { Mistral } from '@mistralai/mistralai';
import type { ChatCompletionRequestMessage } from '@mistralai/mistralai/models/components/chatcompletionrequest.js';
import {
  TraceRoot,
  observe,
  usingAttributes,
  getCurrentTraceId,
} from '@traceroot-ai/traceroot';
import { tracedComplete } from './traced-mistral.js';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
// Pass an empty `instrumentModules` to explicitly opt out of RITM
// auto-instrumentation — Mistral isn't a supported module yet (#739) and we
// handle span emission manually in ./traced-mistral.ts. When auto-instrumentation
// lands, replace this with `{ instrumentModules: { mistral: mistralSdk } }`.
TraceRoot.initialize({ instrumentModules: {} });

const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY ?? '' });
console.log('[Observability: TraceRoot | Provider: Mistral]');

// ── Tools ─────────────────────────────────────────────────────────────────────
type ToolResult = Record<string, unknown>;

function getWeather(city: string): ToolResult {
  const db: Record<string, ToolResult> = {
    'san francisco': { temp: 68, condition: 'foggy', humidity: 75 },
    'new york': { temp: 45, condition: 'cloudy', humidity: 60 },
    london: { temp: 52, condition: 'rainy', humidity: 85 },
    tokyo: { temp: 72, condition: 'sunny', humidity: 50 },
    paris: { temp: 58, condition: 'partly cloudy', humidity: 65 },
  };
  return { city, ...(db[city.toLowerCase()] ?? { temp: 70, condition: 'unknown', humidity: 50 }) };
}

function searchWeb(query: string): ToolResult[] {
  return [
    { title: `Result 1 for '${query}'`, snippet: `This is information about ${query}...` },
    { title: `Result 2 for '${query}'`, snippet: `More details on ${query} can be found...` },
  ];
}

function getStockPrice(symbol: string): ToolResult {
  const stocks: Record<string, ToolResult> = {
    AAPL: { price: 178.5, change: +2.3, percent: '+1.3%' },
    GOOGL: { price: 141.2, change: -0.8, percent: '-0.6%' },
    MSFT: { price: 378.9, change: +4.5, percent: '+1.2%' },
    NVDA: { price: 495.2, change: +12.3, percent: '+2.5%' },
  };
  return {
    symbol: symbol.toUpperCase(),
    ...(stocks[symbol.toUpperCase()] ?? { price: 0, change: 0, percent: 'N/A' }),
  };
}

// Recursive-descent parser for + - * / ( ) — no dynamic code execution.
function calculate(expression: string): ToolResult {
  try {
    let pos = 0;
    const src = expression.replace(/\s+/g, '');

    const peek = () => src[pos];
    const consume = (ch: string) => {
      if (src[pos] !== ch) throw new Error(`Expected '${ch}' at ${pos}`);
      pos++;
    };

    const parseNumber = (): number => {
      const start = pos;
      let hasDot = false;
      while (pos < src.length && (/[0-9]/.test(src[pos]) || (src[pos] === '.' && !hasDot))) {
        if (src[pos] === '.') hasDot = true;
        pos++;
      }
      if (start === pos) throw new Error(`Expected number at ${pos}`);
      return Number(src.slice(start, pos));
    };

    const parseFactor = (): number => {
      if (peek() === '(') {
        consume('(');
        const v = parseAddSub();
        consume(')');
        return v;
      }
      if (peek() === '-') {
        consume('-');
        return -parseFactor();
      }
      return parseNumber();
    };

    const parseMulDiv = (): number => {
      let v = parseFactor();
      while (peek() === '*' || peek() === '/') {
        const op = src[pos++];
        const r = parseFactor();
        v = op === '*' ? v * r : v / r;
      }
      return v;
    };

    function parseAddSub(): number {
      let v = parseMulDiv();
      while (peek() === '+' || peek() === '-') {
        const op = src[pos++];
        const r = parseMulDiv();
        v = op === '+' ? v + r : v - r;
      }
      return v;
    }

    const result = parseAddSub();
    if (pos !== src.length) throw new Error(`Unexpected '${src[pos]}' at ${pos}`);
    return { expression, result };
  } catch (e) {
    return { error: String(e) };
  }
}

function getCurrentTime(timezone = 'UTC'): ToolResult {
  try {
    const time = new Date().toLocaleString('en-US', { timeZone: timezone, hour12: false });
    return { timezone, time };
  } catch {
    return {
      timezone: 'UTC',
      time: new Date().toISOString(),
      warning: `Unknown timezone '${timezone}'; fell back to UTC.`,
    };
  }
}

const TOOLS: Record<string, (a: Record<string, unknown>) => ToolResult | ToolResult[]> = {
  get_weather: (a) => getWeather(a.city as string),
  search_web: (a) => searchWeb(a.query as string),
  get_stock_price: (a) => getStockPrice(a.symbol as string),
  calculate: (a) => calculate(a.expression as string),
  get_current_time: (a) => getCurrentTime(a.timezone as string | undefined),
};

const TOOL_SCHEMAS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string', description: 'City name' } },
        required: ['city'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_web',
      description: 'Search the web for information',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_stock_price',
      description: 'Get current stock price for a ticker symbol',
      parameters: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL)' },
        },
        required: ['symbol'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string', description: 'Math expression' } },
        required: ['expression'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_current_time',
      description: 'Get the current date and time',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'Timezone (default: UTC)' } },
      },
    },
  },
];

// ── Agent ─────────────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a helpful AI assistant with access to tools.
When answering questions:
1. Think about what information you need
2. Use available tools to gather information
3. Combine information from multiple sources when helpful
4. Provide a clear, comprehensive answer
Available tools: weather, web search, stock prices, calculator, current time.`;

class ReActAgent {
  private conversationHistory: ChatCompletionRequestMessage[] = [];
  private readonly model = 'mistral-large-latest';

  constructor() {
    this.conversationHistory.push({ role: 'system', content: SYSTEM_PROMPT });
  }

  private async executeTool(name: string, fnArgs: Record<string, unknown>): Promise<string> {
    const result = await observe({ name: `tool:${name}`, type: 'tool' }, async () => {
      if (name in TOOLS) return TOOLS[name](fnArgs);
      return { error: `Unknown tool: ${name}` };
    });
    return JSON.stringify(result);
  }

  async runTurn(userInput: string): Promise<string> {
    return observe({ name: 'agent_turn', type: 'agent' }, async () => {
      this.conversationHistory.push({ role: 'user', content: userInput });

      for (let i = 0; i < 5; i++) {
        const completion = await tracedComplete(mistral, {
          model: this.model,
          messages: this.conversationHistory,
          tools: TOOL_SCHEMAS,
          toolChoice: 'auto',
          parallelToolCalls: false,
        });

        const msg = completion.choices?.[0]?.message;
        if (!msg) {
          return 'No response from model.';
        }

        const toolCalls = msg.toolCalls ?? [];
        if (toolCalls.length > 0) {
          this.conversationHistory.push({
            role: 'assistant',
            content: typeof msg.content === 'string' ? msg.content : '',
            toolCalls,
          });

          for (const tc of toolCalls) {
            const rawArgs = tc.function.arguments;
            const fnArgs =
              typeof rawArgs === 'string'
                ? (JSON.parse(rawArgs) as Record<string, unknown>)
                : (rawArgs as Record<string, unknown>);
            console.log(`\n  [Tool: ${tc.function.name}(${JSON.stringify(fnArgs)})]`);
            const result = await this.executeTool(tc.function.name, fnArgs);
            console.log(`  [Result: ${result}]`);
            this.conversationHistory.push({
              role: 'tool',
              name: tc.function.name,
              toolCallId: tc.id,
              content: result,
            });
          }
        } else {
          const response = typeof msg.content === 'string' ? msg.content : '';
          this.conversationHistory.push({ role: 'assistant', content: response });
          return response;
        }
      }
      return "I wasn't able to complete this task within the allowed steps.";
    });
  }
}

// ── Demo ──────────────────────────────────────────────────────────────────────
const DEMO_QUERIES = [
  "What's the weather in San Francisco and Tokyo? Compare them.",
  "What's NVDA stock price? If it goes up 10%, what would the new price be?",
  'Search for information about AI observability and summarize what you find.',
];

async function main() {
  const queries = process.argv.includes('--full') ? DEMO_QUERIES : DEMO_QUERIES.slice(0, 1);

  let demoTraceId: string | undefined;

  try {
    await usingAttributes(
      {
        sessionId: 'mistral-demo-session',
        userId: 'demo-user',
        tags: ['demo', 'mistral', 'react-agent'],
        metadata: { example: 'mistral-react-agent', sdkFeature: 'usingAttributes' },
      },
      () =>
        observe({ name: 'demo_session' }, async () => {
          demoTraceId = getCurrentTraceId();
          console.log('='.repeat(60));
          console.log('Mistral ReAct Agent — Demo (TraceRoot)');
          console.log('='.repeat(60));
          if (demoTraceId) console.log(`Trace ID: ${demoTraceId}`);

          for (let i = 0; i < queries.length; i++) {
            const query = queries[i];
            const agent = new ReActAgent();
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Query ${i + 1}: ${query}`);
            console.log('='.repeat(60));
            process.stdout.write('\nAgent: ');
            const response = await agent.runTurn(query);
            console.log(response);
            console.log();
          }
        }),
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('[Traces exported]');

    if (demoTraceId) {
      const host = (process.env.TRACEROOT_HOST_URL ?? 'https://app.traceroot.ai').replace(
        /\/$/,
        '',
      );
      console.log('\nView this trace in TraceRoot:');
      console.log(`  ${host}/traces/${demoTraceId}`);
      console.log(
        '  (or filter by sessionId="mistral-demo-session" / tag="mistral" in the UI)',
      );
    }
  }
}

main().catch(console.error);
