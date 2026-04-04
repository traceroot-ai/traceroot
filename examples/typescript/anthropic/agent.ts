/**
 * Anthropic Tool Agent — TraceRoot Observability
 *
 * A ReAct-style agent that uses Anthropic's tool_use API to answer queries.
 * Instrumented with TraceRoot via TraceRoot.initialize().
 *
 * anthropic: patches the Anthropic SDK to trace all LLM call spans.
 *
 * Env vars required: ANTHROPIC_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';

import Anthropic from '@anthropic-ai/sdk';
import * as anthropicSDK from '@anthropic-ai/sdk';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({ instrumentModules: { anthropic: anthropicSDK } });
console.log('[Observability: TraceRoot]');

// ── Tool implementations ──────────────────────────────────────────────────────

const weatherDb: Record<string, { temp: number; condition: string; humidity: number }> = {
  'san francisco': { temp: 68, condition: 'foggy', humidity: 75 },
  'new york': { temp: 45, condition: 'cloudy', humidity: 60 },
  london: { temp: 52, condition: 'rainy', humidity: 85 },
  tokyo: { temp: 72, condition: 'sunny', humidity: 50 },
};

async function getWeather(city: string): Promise<Record<string, unknown>> {
  return observe({ name: 'get_weather', type: 'tool' }, async () => {
    const data = weatherDb[city.toLowerCase()] ?? { temp: 70, condition: 'unknown', humidity: 50 };
    return { city, ...data };
  });
}

const stocks: Record<string, { price: number; change: number; percent: string }> = {
  AAPL: { price: 178.5, change: 2.3, percent: '+1.3%' },
  GOOGL: { price: 141.2, change: -0.8, percent: '-0.6%' },
  MSFT: { price: 378.9, change: 4.5, percent: '+1.2%' },
  NVDA: { price: 495.2, change: 12.3, percent: '+2.5%' },
};

async function getStockPrice(symbol: string): Promise<Record<string, unknown>> {
  return observe({ name: 'get_stock_price', type: 'tool' }, async () => {
    const upper = symbol.toUpperCase();
    const data = stocks[upper] ?? { price: 0, change: 0, percent: 'N/A' };
    return { symbol: upper, ...data };
  });
}

async function calculate(expression: string): Promise<Record<string, unknown>> {
  return observe({ name: 'calculate', type: 'tool' }, async () => {
    try {
      // Safe evaluation: only allow numbers and basic arithmetic operators
      if (!/^[\d\s+\-*/().]+$/.test(expression)) {
        return { error: `Unsupported expression: ${expression}` };
      }
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${expression})`)() as number;
      return { expression, result };
    } catch (e: unknown) {
      return { error: String(e) };
    }
  });
}

async function getCurrentTime(timezone: string = 'UTC'): Promise<Record<string, unknown>> {
  return observe({ name: 'get_current_time', type: 'tool' }, async () => {
    return { timezone, time: new Date().toISOString().replace('T', ' ').slice(0, 19) };
  });
}

// ── Tool registry ─────────────────────────────────────────────────────────────

type ToolInput = Record<string, string>;

const TOOLS: Record<string, (args: ToolInput) => Promise<Record<string, unknown>>> = {
  get_weather: (args) => getWeather(args.city),
  get_stock_price: (args) => getStockPrice(args.symbol),
  calculate: (args) => calculate(args.expression),
  get_current_time: (args) => getCurrentTime(args.timezone),
};

const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'get_weather',
    description: 'Get current weather for a city',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
  {
    name: 'get_stock_price',
    description: 'Get current stock price for a ticker symbol',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'calculate',
    description: 'Evaluate a mathematical expression',
    input_schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: "Math expression (e.g., '2 + 2 * 3')" },
      },
      required: ['expression'],
    },
  },
  {
    name: 'get_current_time',
    description: 'Get the current date and time',
    input_schema: {
      type: 'object',
      properties: { timezone: { type: 'string', description: 'Timezone (default: UTC)' } },
    },
  },
];

// ── Agent ─────────────────────────────────────────────────────────────────────

class ReActAgent {
  private client: Anthropic;
  private model: string;
  private messages: Anthropic.MessageParam[];
  private system: string;

  constructor(model = 'claude-sonnet-4-5-20250929') {
    this.client = new Anthropic();
    this.model = model;
    this.messages = [];
    this.system =
      'You are a helpful AI assistant with access to tools. ' +
      'Use available tools to gather information, then provide ' +
      'a clear, comprehensive answer.';
  }

  private async executeTool(name: string, input: ToolInput): Promise<string> {
    const fn = TOOLS[name];
    if (!fn) return JSON.stringify({ error: `Unknown tool: ${name}` });
    try {
      const result = await fn(input);
      return JSON.stringify(result);
    } catch (e: unknown) {
      return JSON.stringify({ error: String(e) });
    }
  }

  async run(query: string): Promise<string> {
    return observe({ name: 'agent_turn', type: 'agent' }, async () => {
      this.messages.push({ role: 'user', content: query });

      for (let step = 0; step < 6; step++) {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 4096,
          system: this.system,
          tools: TOOL_SCHEMAS,
          messages: this.messages,
        });

        if (response.stop_reason === 'tool_use') {
          this.messages.push({ role: 'assistant', content: response.content });

          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type === 'tool_use') {
              console.log(`Tool call: ${block.name}(${JSON.stringify(block.input)})`);
              const result = await this.executeTool(block.name, block.input as ToolInput);
              console.log(`Tool result: ${result}`);
              toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
            }
          }
          this.messages.push({ role: 'user', content: toolResults });
        } else {
          let text = '';
          for (const block of response.content) {
            if (block.type === 'text') text += block.text;
          }
          this.messages.push({ role: 'assistant', content: response.content });
          return text;
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
      { userId: 'example-user', sessionId: 'anthropic-ts-session' },
      () =>
        observe({ name: 'demo_session', type: 'agent' }, async () => {
          console.log('='.repeat(60));
          console.log('Anthropic Tool Agent — Demo (TraceRoot)');
          console.log('='.repeat(60));

          for (let i = 0; i < DEMO_QUERIES.length; i++) {
            const query = DEMO_QUERIES[i];
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Query ${i + 1}: ${query}`);
            console.log('='.repeat(60));
            const agent = new ReActAgent();
            const result = await agent.run(query);
            console.log('\nAgent: ' + result);
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
