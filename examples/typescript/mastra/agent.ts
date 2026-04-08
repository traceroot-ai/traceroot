import 'dotenv/config';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core';
import { Observability } from '@mastra/observability';
import { anthropic } from '@ai-sdk/anthropic';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { TraceRootExporter } from '@traceroot-ai/mastra';
import { TraceRoot, observe, usingAttributes, getCurrentTraceId, getCurrentSpanId } from '@traceroot-ai/traceroot';

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

// Auto-detects git context (repo, branch, sha) and attaches it to every span.
TraceRoot.initialize({ instrumentModules: {} });

// ---------------------------------------------------------------------------
// Mastra setup
// ---------------------------------------------------------------------------

const weatherAgent = new Agent({
  id: 'weatherAgent',
  name: 'Weather Agent',
  instructions:
    'You are a helpful weather assistant. Use the get_weather tool to answer questions about current weather conditions.',
  model: anthropic('claude-haiku-4-5-20251001'),
  tools: { getWeatherTool },
});

const exporter = new TraceRootExporter({
  apiKey: process.env['TRACEROOT_API_KEY'],
});

const mastra = new Mastra({
  agents: { weatherAgent },
  observability: new Observability({
    configs: {
      traceroot: {
        serviceName: 'mastra-weather-agent',
        exporters: [exporter],
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

// A stable ID shared across all calls in this demo run.
// Both traces will appear grouped under the same session in TraceRoot.
const SESSION_ID = `demo-${Date.now()}`;
const USER_ID = 'demo-user';

async function main() {
  const agent = mastra.getAgent('weatherAgent');

  try {
    await usingAttributes({ sessionId: SESSION_ID, userId: USER_ID }, () =>
      observe({ name: 'demo_session', type: 'agent' }, async () => {
        const traceId = getCurrentTraceId();
        const parentSpanId = getCurrentSpanId();

        for (const query of QUERIES) {
          console.log(`\nQuery: ${query}`);
          const result = await agent.generate(query, {
            tracingOptions: {
              traceId,
              parentSpanId,
              metadata: {
                sessionId: SESSION_ID,
                userId: USER_ID,
              },
            },
          });
          console.log(`Answer: ${result.text}`);
        }
      }),
    );
  } finally {
    await exporter.flush();
    await TraceRoot.shutdown();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
