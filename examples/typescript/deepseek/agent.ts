/**
 * DeepSeek ReAct Agent — TraceRoot Observability
 *
 * DeepSeek's API is OpenAI-wire-compatible, so we use the official `openai`
 * SDK with `baseURL` pointed at DeepSeek and a DeepSeek model name
 * (e.g. "deepseek-chat" for V3, "deepseek-reasoner" for R1).
 * TraceRoot's existing OpenAI instrumentation captures the calls
 * automatically — no extra wiring.
 *
 * Env vars required: DEEPSEEK_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({
  instrumentModules: { openAI: OpenAI },
});

// ── DeepSeek client (OpenAI SDK with custom baseURL) ──────────────────────────
const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

console.log('[Observability: TraceRoot | Provider: DeepSeek]');

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

// Tiny recursive-descent parser for + - * / ( ) — no dynamic code execution.
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
  // Use IANA timezone (e.g. 'UTC', 'America/New_York'). Fall back to UTC ISO on unknown zones.
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

const TOOL_SCHEMAS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
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
    type: 'function',
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
    type: 'function',
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
    type: 'function',
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
    type: 'function',
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
  private conversationHistory: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  // "deepseek-chat" = V3 (general-purpose, supports tool use).
  // "deepseek-reasoner" = R1 (reasoning model — thinking-token format isn't
  // wired into this ReAct loop; use it for non-tool-calling chats).
  private readonly model = 'deepseek-chat';

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
        const completion = await openai.chat.completions.create({
          model: this.model,
          messages: this.conversationHistory,
          tools: TOOL_SCHEMAS,
          tool_choice: 'auto',
        });

        const msg = completion.choices[0].message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          this.conversationHistory.push(msg);
          for (const tc of msg.tool_calls) {
            const fnArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            console.log(`\n  [Tool: ${tc.function.name}(${JSON.stringify(fnArgs)})]`);
            const result = await this.executeTool(tc.function.name, fnArgs);
            console.log(`  [Result: ${result}]`);
            this.conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
        } else {
          const response = msg.content ?? '';
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
  try {
    await usingAttributes(
      {
        sessionId: 'deepseek-demo-session',
        userId: 'demo-user',
        tags: ['demo', 'deepseek', 'react-agent'],
        metadata: { example: 'deepseek-react-agent', sdkFeature: 'usingAttributes' },
      },
      () =>
        observe({ name: 'demo_session' }, async () => {
          console.log('='.repeat(60));
          console.log('DeepSeek ReAct Agent — Demo (TraceRoot)');
          console.log('='.repeat(60));

          for (let i = 0; i < DEMO_QUERIES.length; i++) {
            const query = DEMO_QUERIES[i];
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
  }
}

main().catch(console.error);
