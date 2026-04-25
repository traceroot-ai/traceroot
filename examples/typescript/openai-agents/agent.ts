/**
 * OpenAI Agents SDK — TraceRoot Observability
 *
 * A simple multi-tool agent using @openai/agents, with traces captured
 * by TraceRoot via the built-in TracingProcessor bridge.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';
import * as agents from '@openai/agents';
import { Agent, run, tool } from '@openai/agents';
import { TraceRoot } from '@traceroot-ai/traceroot';
import { z } from 'zod/v4';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({
  instrumentModules: { openaiAgents: agents },
});
console.log('[Observability: TraceRoot]');

// ── Tools ─────────────────────────────────────────────────────────────────────

const getWeather = tool({
  name: 'get_weather',
  description: 'Get current weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    const db: Record<string, { temp: number; condition: string; humidity: number }> = {
      'san francisco': { temp: 68, condition: 'foggy', humidity: 75 },
      'new york': { temp: 45, condition: 'cloudy', humidity: 60 },
      'tokyo': { temp: 72, condition: 'sunny', humidity: 50 },
      'london': { temp: 52, condition: 'rainy', humidity: 85 },
    };
    return db[city.toLowerCase()] ?? { temp: 70, condition: 'unknown', humidity: 50 };
  },
});

const getStockPrice = tool({
  name: 'get_stock_price',
  description: 'Get current stock price for a ticker symbol.',
  parameters: z.object({ symbol: z.string() }),
  execute: async ({ symbol }) => {
    const stocks: Record<string, { price: number; change: string }> = {
      NVDA: { price: 495.2, change: '+2.1%' },
      AAPL: { price: 178.5, change: '+1.3%' },
      GOOGL: { price: 141.2, change: '-0.6%' },
    };
    return stocks[symbol.toUpperCase()] ?? { price: 0, change: 'N/A' };
  },
});

const calculate = tool({
  name: 'calculate',
  description: 'Evaluate a math expression. Example: "178.5 * 1.1"',
  parameters: z.object({ expression: z.string() }),
  execute: async ({ expression }) => {
    try {
      // Safe eval for simple arithmetic
      const result = Function(`"use strict"; return (${expression})`)();
      return { expression, result };
    } catch {
      return { expression, error: 'Invalid expression' };
    }
  },
});

// ── Agent ─────────────────────────────────────────────────────────────────────

const agent = new Agent({
  name: 'Assistant',
  instructions:
    'You are a helpful assistant with access to weather, stock price, and calculator tools. ' +
    'Use tools when needed to answer questions accurately.',
  tools: [getWeather, getStockPrice, calculate],
});

// ── Demo ──────────────────────────────────────────────────────────────────────

const DEMO_QUERIES = [
  "What's the weather in San Francisco and Tokyo? Compare them.",
  "What's NVDA stock price? If it goes up 10%, what would the new price be?",
];

async function main() {
  console.log('============================================================');
  console.log('OpenAI Agents SDK — Demo (TraceRoot)');
  console.log('============================================================\n');

  for (const query of DEMO_QUERIES) {
    console.log(`Query: ${query}`);
    const result = await run(agent, query);
    console.log(`\nAgent: ${result.finalOutput}\n`);
    console.log('------------------------------------------------------------\n');
  }

  await TraceRoot.shutdown();
  console.log('[Traces exported]');
}

main().catch(console.error);
