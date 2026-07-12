/**
 * Groq ReAct agent with tool use and TraceRoot observability.
 *
 * Groq's API is OpenAI-wire-compatible, so we use the official `openai` SDK
 * with `baseURL` pointed at Groq's OpenAI-compatible endpoint and a Groq model
 * name (e.g. "llama-3.3-70b-versatile"). TraceRoot's existing OpenAI
 * instrumentation captures the calls automatically — no extra wiring.
 *
 * Usage:
 *   cp .env.example .env
 *   npm install
 *   npm start
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({
  instrumentModules: { openAI: OpenAI },
});

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

// ── Tools ─────────────────────────────────────────────────────────────────────
type ToolResult = Record<string, unknown>;

function getWeather(city: string): ToolResult {
  const db: Record<string, ToolResult> = {
    'san francisco': { temp: 68, condition: 'foggy', humidity: 75 },
    'new york': { temp: 45, condition: 'cloudy', humidity: 60 },
    london: { temp: 52, condition: 'rainy', humidity: 85 },
    tokyo: { temp: 72, condition: 'sunny', humidity: 50 },
  };
  return { city, ...(db[city.toLowerCase()] ?? { temp: 70, condition: 'unknown', humidity: 50 }) };
}

function getStockPrice(symbol: string): ToolResult {
  const stocks: Record<string, ToolResult> = {
    AAPL: { price: 178.5, change: 2.3, percent: '+1.3%' },
    GOOGL: { price: 141.2, change: -0.8, percent: '-0.6%' },
    MSFT: { price: 378.9, change: 4.5, percent: '+1.2%' },
    NVDA: { price: 495.2, change: 12.3, percent: '+2.5%' },
  };
  return {
    symbol: symbol.toUpperCase(),
    ...(stocks[symbol.toUpperCase()] ?? { price: 0, change: 0, percent: 'N/A' }),
  };
}

function calculate(expression: string): ToolResult {
  try {
    if (!/^[\d\s+\-*/().]+$/.test(expression)) {
      return { error: 'Unsupported expression characters' };
    }
    // eslint-disable-next-line no-eval
    const result = Function(`"use strict"; return (${expression})`)() as number;
    return { expression, result };
  } catch (e) {
    return { error: String(e) };
  }
}

function getCurrentTime(timezone = 'UTC'): ToolResult {
  try {
    const time = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date());
    return { timezone, time };
  } catch {
    // Invalid timezone — fall back to UTC.
    return { timezone: 'UTC', time: new Date().toISOString() };
  }
}

const TOOLS: Record<string, (a: Record<string, unknown>) => ToolResult> = {
  get_weather: (a) => getWeather(a.city as string),
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
        properties: {
          expression: { type: 'string', description: "Math expression (e.g., '2 + 2 * 3')" },
        },
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
        properties: {
          timezone: { type: 'string', description: 'Timezone (default: UTC)' },
        },
      },
    },
  },
];

// ── Agent ─────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a helpful AI assistant with access to tools.
Use available tools to gather information, then provide a clear, comprehensive answer.`;

class ReActAgent {
  private client: OpenAI;
  private model: string;
  private messages: OpenAI.Chat.ChatCompletionMessageParam[];

  constructor(model = 'llama-3.3-70b-versatile') {
    this.client = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: GROQ_BASE_URL,
    });
    this.model = model;
    this.messages = [{ role: 'system', content: SYSTEM_PROMPT }];
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
      this.messages.push({ role: 'user', content: userInput });

      for (let i = 0; i < 5; i++) {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages: this.messages,
          tools: TOOL_SCHEMAS,
        });

        const msg = completion.choices[0].message;

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          this.messages.push(msg);
          for (const tc of msg.tool_calls) {
            const fnArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            console.log(`\n  [Tool: ${tc.function.name}(${JSON.stringify(fnArgs)})]`);
            const result = await this.executeTool(tc.function.name, fnArgs);
            console.log(`  [Result: ${result}]`);
            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
        } else {
          const response = msg.content ?? '';
          this.messages.push({ role: 'assistant', content: response });
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
];

async function main() {
  try {
    await usingAttributes(
      {
        sessionId: 'groq-tool-agent-session',
        userId: 'example-user',
        tags: ['demo', 'groq', 'react-agent'],
        metadata: { example: 'groq-react-agent' },
      },
      () =>
        observe({ name: 'demo_session' }, async () => {
          console.log('='.repeat(60));
          console.log('Groq ReAct Agent — Demo (TraceRoot)');
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
