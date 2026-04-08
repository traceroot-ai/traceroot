import 'dotenv/config';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { Observability } from '@mastra/observability';
import { anthropic } from '@ai-sdk/anthropic';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TraceRootExporter } from '@traceroot-ai/mastra';
import {
  TraceRoot,
  observe,
  usingAttributes,
  getCurrentTraceId,
  getCurrentSpanId,
} from '@traceroot-ai/traceroot';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const getWeatherTool = createTool({
  id: 'get_weather',
  description: 'Get the current weather for a city',
  inputSchema: z.object({
    city: z.string().describe('City name'),
  }),
  outputSchema: z.object({
    temperature: z.number(),
    condition: z.string(),
    humidity: z.number(),
  }),
  execute: async (inputData) => {
    const mockData: Record<string, { temperature: number; condition: string; humidity: number }> = {
      'san francisco': { temperature: 62, condition: 'Foggy', humidity: 78 },
      'new york': { temperature: 45, condition: 'Cloudy', humidity: 65 },
      'london': { temperature: 50, condition: 'Rainy', humidity: 85 },
      'tokyo': { temperature: 55, condition: 'Partly Cloudy', humidity: 70 },
    };
    const key = inputData.city.toLowerCase();
    const weather = mockData[key] ?? { temperature: 72, condition: 'Sunny', humidity: 55 };
    console.log(`[tool] get_weather(${inputData.city}) →`, weather);
    return weather;
  },
});

// ---------------------------------------------------------------------------
// Agent — defined and exported at module scope, just like in real apps.
//
// In many codebases the agent is defined in one file, exported, and imported
// wherever it's needed — without going through mastra.getAgent(). This
// example shows that pattern works fine with TraceRoot.
// ---------------------------------------------------------------------------

export const weatherAgent = new Agent({
  id: 'weatherAgent',
  name: 'Weather Agent',
  instructions:
    'You are a helpful weather assistant. Use the get_weather tool to answer questions about current weather conditions.',
  model: anthropic('claude-haiku-4-5-20251001'),
  tools: { getWeatherTool },
});

// ---------------------------------------------------------------------------
// TraceRoot setup
//
// TraceRoot.initialize() sets up the OTEL pipeline used by observe() and
// usingAttributes(). It also auto-detects git context (repo, branch, sha)
// so those appear on every span without any manual config.
//
// The Mastra observability wires up Mastra's internal event bus so every
// agent.stream() call emits spans via TraceRootExporter. Passing traceId +
// parentSpanId from the outer observe() into tracingOptions links those
// Mastra spans as children of the session span — one unified trace tree.
// ---------------------------------------------------------------------------

// instrumentModules: {} — Mastra handles its own spans; no SDK auto-patching needed.
TraceRoot.initialize({ instrumentModules: {} });

const mastraExporter = new TraceRootExporter({
  apiKey: process.env['TRACEROOT_API_KEY'],
});

new Mastra({
  agents: { weatherAgent },
  observability: new Observability({
    configs: {
      traceroot: {
        serviceName: 'mastra-weather-agent-streaming',
        exporters: [mastraExporter],
      },
    },
  }),
});

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

const QUERIES = [
  "What's the weather like in San Francisco right now?",
  "Compare the weather in New York and London — which one is warmer?",
];

const SESSION_ID = `demo-stream-${Date.now()}`;
const USER_ID = 'demo-user';

async function main() {
  try {
    await usingAttributes({ sessionId: SESSION_ID, userId: USER_ID }, () =>
      observe({ name: 'demo_session', type: 'agent' }, async () => {
        // Capture the OTEL span context so Mastra's agent spans are parented
        // to this session span — both queries appear under one trace tree.
        const traceId = getCurrentTraceId();
        const parentSpanId = getCurrentSpanId();

        for (const query of QUERIES) {
          console.log(`\nQuery: ${query}`);
          process.stdout.write('Answer: ');

          const result = await weatherAgent.stream(query, {
            tracingOptions: {
              traceId,
              parentSpanId,
              // sessionId/userId for Mastra's own exporter (reads span.metadata,
              // not the OTEL context propagated by usingAttributes above).
              metadata: {
                sessionId: SESSION_ID,
                userId: USER_ID,
              },
            },
          });

          for await (const chunk of result.textStream) {
            process.stdout.write(chunk);
          }
          console.log();
        }
      }),
    );
  } finally {
    await mastraExporter.flush();
    await TraceRoot.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
