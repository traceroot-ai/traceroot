/**
 * Claude Agent SDK — TraceRoot Observability
 *
 * Multi-agent research pipeline using Claude Code as a library.
 * Demonstrates subagents, multiple built-in tools, and TraceRoot tracing.
 *
 * Env vars required: ANTHROPIC_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';
import * as claudeAgentSDK from '@anthropic-ai/claude-agent-sdk';
import { TraceRoot, observe, usingAttributes, getPatchedModule } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
TraceRoot.initialize({
  instrumentModules: { claudeAgentSDK },
});

// Get the instrumented version of the SDK (ESM modules are frozen,
// so the instrumentor returns a patched copy via getPatchedModule).
const sdk = getPatchedModule('claudeAgentSDK', claudeAgentSDK);

console.log('[Observability: TraceRoot]');

// ── Subagent definitions ──────────────────────────────────────────────────────
const RESEARCHER: claudeAgentSDK.AgentDefinition = {
  description:
    'Research specialist. Use when you need to gather information about a topic from the web.',
  prompt:
    'You are a research specialist. Use WebSearch to find relevant information. Provide a concise summary with key facts. Keep your response under 200 words.',
  tools: ['WebSearch'],
  model: 'haiku',
};

const ANALYST: claudeAgentSDK.AgentDefinition = {
  description:
    'Data analyst. Use for calculations, data processing, or generating statistics.',
  prompt:
    'You are a data analyst. Use Bash with python3 to perform calculations or data processing. Provide clear numerical results. Keep your response concise.',
  tools: ['Bash'],
  model: 'haiku',
};

const WRITER: claudeAgentSDK.AgentDefinition = {
  description:
    'Report writer. Synthesizes research findings and analysis into a clear summary report.',
  prompt:
    'You are a report writer. Synthesize the information provided into a clear, well-structured summary. Use bullet points and headers. Keep the report under 300 words.',
  tools: [],
  model: 'haiku',
};

// ── Agent ─────────────────────────────────────────────────────────────────────
async function runResearch(topic: string): Promise<string> {
  return observe({ name: 'research_pipeline', type: 'agent' }, async () => {
    let resultText = '';

    for await (const message of sdk.query({
      prompt: [
        `Research the following topic using a multi-step approach:\n\n`,
        `Topic: ${topic}\n\n`,
        `Steps:\n`,
        `1. Use the researcher agent to gather key facts about this topic\n`,
        `2. Use the analyst agent to calculate or process any relevant numbers\n`,
        `3. Use the writer agent to produce a final summary report\n\n`,
        `Coordinate the agents and present the final report.`,
      ].join(''),
      options: {
        allowedTools: ['Agent'],
        maxTurns: 15,
        agents: {
          researcher: RESEARCHER,
          analyst: ANALYST,
          writer: WRITER,
        },
      },
    })) {
      if ('result' in message && (message as any).result) {
        resultText = (message as any).result;
      }
    }

    return resultText;
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────
const DEMO_TOPICS = [
  'What are the key features of OpenTelemetry for AI observability?',
];

async function main() {
  try {
    await usingAttributes(
      {
        sessionId: 'claude-agent-sdk-ts-session',
        userId: 'demo-user',
        tags: ['demo', 'claude-agent-sdk', 'research-pipeline'],
      },
      () =>
        observe({ name: 'demo_session' }, async () => {
          console.log('='.repeat(60));
          console.log('Claude Agent SDK Research Pipeline — Demo (TraceRoot)');
          console.log('='.repeat(60));

          for (let i = 0; i < DEMO_TOPICS.length; i++) {
            const topic = DEMO_TOPICS[i];
            console.log(`\n${'='.repeat(60)}`);
            console.log(`Research ${i + 1}: ${topic}`);
            console.log('='.repeat(60));
            const result = await runResearch(topic);
            if (result) {
              console.log(`\n${result}`);
            }
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
