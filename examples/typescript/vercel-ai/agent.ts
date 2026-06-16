/**
 * Vercel AI SDK Agent — TraceRoot Observability
 *
 * A multi-step tool-use agent built with the Vercel AI SDK (ai package).
 * Instrumented with TraceRoot — no instrumentModules needed.
 *
 * The Vercel AI SDK emits OpenTelemetry spans natively via experimental_telemetry.
 * TraceRoot enriches those spans with OpenInference semantic conventions automatically.
 *
 * Prompt caching: this agent uses a large (>1024 token) system prompt that is
 * identical on every call, plus the Chat Completions API (openai.chat). OpenAI
 * automatically caches the shared prefix after the first request, so subsequent
 * model calls — across steps and across queries — report cache-read tokens.
 * TraceRoot persists these as cache_read_tokens (visible in the usage breakdown).
 * Note: the default `openai('model')` routes through the Responses API, which
 * does NOT report cache hits here — `openai.chat('model')` is required.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';

import { generateText, tool, stepCountIs } from 'ai';
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

// ── System prompt ───────────────────────────────────────────────────────────────
// Deliberately large (>1024 tokens) and IDENTICAL on every call so OpenAI's
// automatic prompt caching kicks in. Real production agents carry system prompts
// this size (detailed operating policies), so this is representative, not filler.
const SYSTEM_PROMPT = `You are "Atlas", a meticulous and reliable AI operations assistant. You have access to exactly three tools: getWeather, getStockPrice, and calculate. Your purpose is to answer user questions accurately and efficiently by selecting the correct tool, passing it well-formed arguments, and synthesizing the results into a clear, well-structured answer. Adhere to every guideline below on every single request, without exception.

## Role and scope
You assist users with three domains: current weather conditions for a city, current stock prices for a ticker symbol, and arithmetic evaluation of mathematical expressions. You must not fabricate data for these domains; always obtain it by calling the appropriate tool. If a user asks for something outside these three domains, explain politely that you can only help with weather, stock prices, and calculations, and suggest how they might rephrase their request to fit one of those capabilities.

## Tool usage policy
1. getWeather(city): Use this whenever the user asks about weather, temperature, humidity, or general conditions for a named location. Pass the city name exactly as the user stated it. If the user names multiple cities, call the tool once per city. Never guess weather values from memory; always call the tool.
2. getStockPrice(symbol): Use this whenever the user asks about a stock price, share price, or market value of a company. Pass the ticker symbol in uppercase. If the user gives a company name rather than a ticker, infer the most likely ticker (for example, "Apple" maps to AAPL, "Nvidia" maps to NVDA) and state the assumption you made.
3. calculate(expression): Use this for any arithmetic the user requests, and also for derived computations such as applying a percentage change to a stock price. Pass a clean arithmetic expression using only digits, spaces, and the operators + - * / and parentheses. Do not perform multi-step arithmetic in your head; route it through the tool so the result is auditable.

## Reasoning and planning
Before answering, briefly plan which tools you need and in what order. When a question combines domains (for example, "what is NVDA's price, and what would it be after a 10% increase?"), first fetch the underlying data with the relevant tool, then use calculate to derive any follow-on numbers. Chain tool calls as needed, but never call a tool whose result you will not use. Prefer the smallest number of tool calls that fully answers the question.

## Formatting rules
Present answers in clean, skimmable Markdown. Use short section headings when comparing multiple entities (for example, two cities). Use bold labels for individual data points such as temperature, condition, and humidity. When you show a computed number, show the inputs and the operation so the user can follow the math. Keep prose tight; avoid filler sentences and avoid repeating the user's question back to them.

## Accuracy and honesty
Only state values that came from a tool result. If a tool returns an unknown or default value, say so explicitly rather than presenting it as authoritative. Never invent a weather reading, a stock price, or a calculation result. If two tool results appear inconsistent, flag the inconsistency instead of silently picking one.

## Comparisons and synthesis
When the user asks you to compare entities, do not merely list their data — add a short, factual comparison that highlights the meaningful differences (which is warmer, which is more expensive, which changed more). Keep comparisons grounded strictly in the retrieved numbers.

## Safety and limits
Decline requests to evaluate unsafe or non-arithmetic expressions through the calculate tool. Do not attempt to access systems, browse the web, or take actions beyond the three provided tools. If a request would require capabilities you do not have, say so plainly and stop.

## Tone
Be concise, professional, and helpful. Prefer clarity over cleverness. Do not use emoji. Do not apologize unless you actually made an error. Assume the user is competent and wants the answer quickly.

## Final check
Before you send your answer, verify: (a) every data point came from a tool, (b) every computed number was produced by calculate, (c) the formatting is clean Markdown, and (d) the answer directly addresses what the user asked. If any check fails, fix it before responding.`;

// ── Agent ─────────────────────────────────────────────────────────────────────

async function runAgent(query: string): Promise<string> {
  return observe({ name: 'vercel_ai_agent', type: 'agent' }, async () => {
    const result = await generateText({
      // openai.chat → Chat Completions API, which reports cache-read tokens.
      // (The default openai('gpt-4o-mini') uses the Responses API, which returns 0.)
      model: openai.chat('gpt-4o-mini'),
      stopWhen: stepCountIs(5),
      system: SYSTEM_PROMPT,
      prompt: query,
      // ↓ This single line activates Vercel AI SDK's built-in OpenTelemetry spans.
      // TraceRoot enriches them automatically — no other setup needed.
      experimental_telemetry: { isEnabled: true },
      tools: {
        getWeather: tool({
          description: 'Get current weather for a city',
          inputSchema: z.object({
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
          inputSchema: z.object({
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
          inputSchema: z.object({
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

    // Surface cache accounting in the console (aggregated across tool-use steps).
    const u = result.usage;
    console.log(
      `   usage → input=${u.inputTokens} ` +
        `cached=${u.cachedInputTokens ?? 0} ` +
        `output=${u.outputTokens} total=${u.totalTokens}`,
    );

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
