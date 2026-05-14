/**
 * AWS Bedrock Tool Agent — TraceRoot Observability
 *
 * A ReAct-style agent that uses Bedrock's Converse API (with toolConfig) to
 * answer queries. Instrumented with TraceRoot via TraceRoot.initialize().
 *
 * bedrock: patches @aws-sdk/client-bedrock-runtime to trace all LLM call spans.
 *
 * Env vars required: AWS_REGION, BEDROCK_MODEL_ID, TRACEROOT_API_KEY
 * AWS credentials picked up from the default AWS SDK credential chain.
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import * as bedrockRuntime from '@aws-sdk/client-bedrock-runtime';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({ instrumentModules: { bedrock: bedrockRuntime } });
console.log('[Observability: TraceRoot]');

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

const REGION = requireEnv('AWS_REGION');
const MODEL_ID = requireEnv('BEDROCK_MODEL_ID');

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

const TOOL_SPECS: Tool[] = [
  {
    toolSpec: {
      name: 'get_weather',
      description: 'Get current weather for a city',
      inputSchema: {
        json: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_stock_price',
      description: 'Get current stock price for a ticker symbol',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: 'Stock ticker symbol (e.g., AAPL)' },
          },
          required: ['symbol'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'calculate',
      description: 'Evaluate a mathematical expression',
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: "Math expression (e.g., '2 + 2 * 3')" },
          },
          required: ['expression'],
        },
      },
    },
  },
  {
    toolSpec: {
      name: 'get_current_time',
      description: 'Get the current date and time',
      inputSchema: {
        json: {
          type: 'object',
          properties: { timezone: { type: 'string', description: 'Timezone (default: UTC)' } },
        },
      },
    },
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function textFromContentBlocks(blocks: ContentBlock[] | undefined): string {
  if (!blocks?.length) return '';
  const parts: string[] = [];
  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.join('');
}

// ── Agent ─────────────────────────────────────────────────────────────────────

class ReActAgent {
  private client: BedrockRuntimeClient;
  private modelId: string;
  private messages: Message[];
  private system: string;

  constructor(modelId = MODEL_ID) {
    this.client = new BedrockRuntimeClient({ region: REGION });
    this.modelId = modelId;
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
      this.messages.push({ role: 'user', content: [{ text: query }] });

      for (let step = 0; step < 6; step++) {
        const response = await this.client.send(
          new ConverseCommand({
            modelId: this.modelId,
            system: [{ text: this.system }],
            toolConfig: { tools: TOOL_SPECS },
            messages: this.messages,
            inferenceConfig: { maxTokens: 4096 },
          }),
        );

        const assistantContent = response.output?.message?.content ?? [];

        if (response.stopReason === 'tool_use') {
          this.messages.push({ role: 'assistant', content: assistantContent });

          const toolResults: ContentBlock[] = [];
          for (const block of assistantContent) {
            if ('toolUse' in block && block.toolUse) {
              const { toolUseId, name, input } = block.toolUse;
              console.log(`Tool call: ${name}(${JSON.stringify(input)})`);
              const result = await this.executeTool(name as string, input as ToolInput);
              console.log(`Tool result: ${result}`);
              toolResults.push({
                toolResult: {
                  toolUseId: toolUseId as string,
                  content: [{ text: result }],
                  status: 'success',
                },
              });
            }
          }
          this.messages.push({ role: 'user', content: toolResults });
        } else {
          this.messages.push({ role: 'assistant', content: assistantContent });
          return textFromContentBlocks(assistantContent);
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

async function main(): Promise<void> {
  try {
    await usingAttributes(
      { userId: 'example-user', sessionId: 'bedrock-ts-session' },
      () =>
        observe({ name: 'demo_session', type: 'agent' }, async () => {
          console.log('='.repeat(60));
          console.log('Bedrock Tool Agent — Demo (TraceRoot)');
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

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
