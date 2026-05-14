/**
 * Vercel AI SDK Agent — TraceRoot Observability
 *
 * A multi-step tool-use agent built with the Vercel AI SDK (ai package).
 * Instrumented with TraceRoot — no instrumentModules needed.
 *
 * The Vercel AI SDK emits OpenTelemetry spans natively via experimental_telemetry.
 * TraceRoot enriches those spans with OpenInference semantic conventions automatically.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';

import { generateText, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
// No instrumentModules needed — Vercel AI SDK telemetry is handled automatically
// via the OpenInference span processor registered inside TraceRoot.initialize().
// Just enable experimental_telemetry on each AI SDK call (see agent below).
TraceRoot.initialize();
console.log('[Observability: TraceRoot]');

// ── Mock data ─────────────────────────────────────────────────────────────────

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

// ── Agent ─────────────────────────────────────────────────────────────────────

async function runAgent(query: string): Promise<string> {
  return observe({ name: 'vercel_ai_agent', type: 'agent' }, async () => {
    const result = await generateText({
      model: openai('gpt-4o-mini'),
      maxSteps: 5,
      system:
        'You are a helpful AI assistant with access to weather and stock tools. ' +
        'Use the tools to answer user questions accurately.',
      prompt: query,
      // ↓ This single line activates Vercel AI SDK's built-in OpenTelemetry spans.
      // TraceRoot enriches them automatically — no other setup needed.
      experimental_telemetry: { isEnabled: true },
      tools: {
        getWeather: tool({
          description: 'Get current weather for a city',
          parameters: z.object({
            city: z.string().describe('The city name'),
          }),
          execute: async ({ city }) => {
            return observe({ name: 'get_weather', type: 'tool' }, async () => {
              const data = weatherDb[city.toLowerCase()] ?? {
                temp: 70,
                condition: 'unknown',
                humidity: 50,
              };
              return { city, ...data };
            });
          },
        }),
        getStockPrice: tool({
          description: 'Get current stock price for a ticker symbol',
          parameters: z.object({
            symbol: z.string().describe('Stock ticker symbol e.g. AAPL'),
          }),
          execute: async ({ symbol }) => {
            return observe({ name: 'get_stock_price', type: 'tool' }, async () => {
              const upper = symbol.toUpperCase();
              const data = stocks[upper] ?? { price: 0, change: 0, percent: 'N/A' };
              return { symbol: upper, ...data };
            });
          },
        }),
        calculate: tool({
          description: 'Evaluate a mathematical expression',
          parameters: z.object({
            expression: z.string().describe("Math expression e.g. '2 + 2 * 3'"),
          }),
          execute: async ({ expression }) => {
            return observe({ name: 'calculate', type: 'tool' }, async () => {
              if (!/^[\d\s+\-*/().]+$/.test(expression)) {
                return { error: `Unsupported expression: ${expression}` };
              }
              try {
                // eslint-disable-next-line no-new-func
                const result = Function(`"use strict"; return (${expression})`)() as number;
                return { expression, result };
              } catch (error) {
                return { error: `Invalid expression: ${expression}` };
              }
            });
          },
        }),
      },
    });

    return result.text;
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────

const DEMO_QUERIES = [
  "What's the weather in San Francisco and Tokyo? Compare them.",
  "What's NVDA stock price? If it goes up 10%, what would the new price be?",
];

async function main() {
  try {
    await usingAttributes(
      { userId: 'example-user', sessionId: 'vercel-ai-ts-session' },
      () =>
        observe({ name: 'demo_session', type: 'agent' }, async () => {
          console.log('='.repeat(60));
          console.log('Vercel AI SDK Agent — Demo (TraceRoot)');
          console.log('='.repeat(60));

          for (let i = 0; i < DEMO_QUERIES.length; i++) {
            const query = DEMO_QUERIES[i];
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Query ${i + 1}: ${query}`);
            console.log('='.repeat(60));
            const result = await runAgent(query);
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