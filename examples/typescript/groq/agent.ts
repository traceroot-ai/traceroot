/**
 * Groq Tool Agent — TraceRoot Observability
 *
 * A ReAct-style agent using Groq's tool-calling API.
 * TraceRoot is initialized with Groq instrumentation enabled.
 *
 * Env vars required: GROQ_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';
import Groq from 'groq-sdk';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({
  instrumentModules: {
    // Cast keeps this example compatible with SDK versions that add Groq typing incrementally.
    groq: Groq,
  } as Record<string, unknown>,
});

console.log('[Observability: TraceRoot | Provider: Groq]');

type ToolResult = Record<string, unknown>;
type ToolArgs = Record<string, unknown>;

const weatherDb: Record<string, { temp: number; condition: string; humidity: number }> = {
  'san francisco': { temp: 68, condition: 'foggy', humidity: 75 },
  'new york': { temp: 45, condition: 'cloudy', humidity: 60 },
  london: { temp: 52, condition: 'rainy', humidity: 85 },
  tokyo: { temp: 72, condition: 'sunny', humidity: 50 },
};

const stocks: Record<string, { price: number; change: number; percent: string }> = {
  AAPL: { price: 178.5, change: 2.3, percent: '+1.3%' },
  GOOGL: { price: 141.2, change: -0.8, percent: '-0.6%' },
  MSFT: { price: 378.9, change: 4.5, percent: '+1.2%' },
  NVDA: { price: 495.2, change: 12.3, percent: '+2.5%' },
};

async function getWeather(city: string): Promise<ToolResult> {
  return observe({ name: 'get_weather', type: 'tool' }, async () => {
    const data = weatherDb[city.toLowerCase()] ?? { temp: 70, condition: 'unknown', humidity: 50 };
    return { city, ...data };
  });
}

async function getStockPrice(symbol: string): Promise<ToolResult> {
  return observe({ name: 'get_stock_price', type: 'tool' }, async () => {
    const upper = symbol.toUpperCase();
    const data = stocks[upper] ?? { price: 0, change: 0, percent: 'N/A' };
    return { symbol: upper, ...data };
  });
}

async function calculate(expression: string): Promise<ToolResult> {
  return observe({ name: 'calculate', type: 'tool' }, async () => {
    try {
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

async function getCurrentTime(timezone = 'UTC'): Promise<ToolResult> {
  return observe({ name: 'get_current_time', type: 'tool' }, async () => {
    try {
      const formatted = new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date());
      return { timezone, time: formatted.replace(' ', 'T') };
    } catch {
      return {
        timezone: 'UTC',
        time: new Date().toISOString().slice(0, 19),
        warning: `Unknown timezone '${timezone}', returned UTC instead.`,
      };
    }
  });
}

const TOOLS: Record<string, (args: ToolArgs) => Promise<ToolResult>> = {
  get_weather: (args) => getWeather(String(args.city ?? '')),
  get_stock_price: (args) => getStockPrice(String(args.symbol ?? '')),
  calculate: (args) => calculate(String(args.expression ?? '')),
  get_current_time: (args) => getCurrentTime(args.timezone ? String(args.timezone) : 'UTC'),
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
        properties: {
          expression: { type: 'string', description: "Math expression (e.g., '2 + 2 * 3')" },
        },
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

class ReActAgent {
  private readonly client: Groq;
  private readonly model: string;
  private readonly messages: Array<Record<string, unknown>>;

  constructor(model = 'llama-3.3-70b-versatile') {
    this.client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    this.model = model;
    this.messages = [
      {
        role: 'system',
        content:
          'You are a helpful AI assistant with access to tools. Use available tools to gather ' +
          'information, then provide a clear, comprehensive answer.',
      },
    ];
  }

  private async executeTool(name: string, args: ToolArgs): Promise<string> {
    const tool = TOOLS[name];
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
    const result = await tool(args);
    return JSON.stringify(result);
  }

  async run(query: string): Promise<string> {
    return observe({ name: 'agent_turn', type: 'agent' }, async () => {
      this.messages.push({ role: 'user', content: query });

      for (let step = 0; step < 6; step++) {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages: this.messages as never,
          tools: TOOL_SCHEMAS,
          tool_choice: 'auto',
        });

        const msg = completion.choices[0]?.message;
        if (!msg) return 'No response from model.';

        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Preserve model tool-call metadata so tool result messages are correctly linked.
          this.messages.push({
            role: 'assistant',
            content: msg.content,
            tool_calls: msg.tool_calls,
          });
          for (const tc of msg.tool_calls) {
            const args = JSON.parse(tc.function.arguments || '{}') as ToolArgs;
            console.log(`Tool call: ${tc.function.name}(${JSON.stringify(args)})`);
            const result = await this.executeTool(tc.function.name, args);
            console.log(`Tool result: ${result}`);
            this.messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          continue;
        }

        const text = msg.content ?? '';
        this.messages.push({ role: 'assistant', content: text });
        return text;
      }

      return "I wasn't able to complete this task within the allowed steps.";
    });
  }
}

const DEMO_QUERIES = [
  "What's the weather in San Francisco and Tokyo? Compare them.",
  "What's NVDA stock price? If it goes up 10%, what would the new price be?",
];

async function main() {
  try {
    await usingAttributes(
      { userId: 'example-user', sessionId: 'groq-ts-session' },
      () =>
        observe({ name: 'demo_session', type: 'agent' }, async () => {
          console.log('='.repeat(60));
          console.log('Groq Tool Agent — Demo (TraceRoot)');
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
