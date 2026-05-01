/**
 * Claude Agent SDK — TraceRoot Observability
 *
 * Multi-agent research pipeline using Claude Code as a library.
 * Demonstrates subagents, multiple built-in tools, and TraceRoot tracing.
 *
 * Env vars: ANTHROPIC_API_KEY, TRACEROOT_API_KEY
 *           TRACEROOT_HOST_URL is optional (defaults to https://app.traceroot.ai)
 *
 * Run:
 *   pnpm install
 *   pnpm demo
 */

import 'dotenv/config';
import * as claudeAgentSDKModule from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// Spread the read-only ESM namespace into a mutable object so the patcher
// can rewrite `query` in place. If you call the original namespace's `query`
// after this point, it will NOT be traced.
const claudeAgentSDK = { ...claudeAgentSDKModule };

TraceRoot.initialize({
  instrumentModules: { claudeAgentSDK },
  disableBatch: true,
});

console.log('[Observability: TraceRoot]');

// ── Subagent definitions ──────────────────────────────────────────────────────
const RESEARCHER: AgentDefinition = {
  description:
    'Research specialist. Use when you need to gather information about a topic from the web. Returns structured research notes.',
  prompt:
    'You are a research specialist. Use WebSearch to find relevant information about the given topic. Provide a concise summary with key facts and sources. Keep your response under 200 words.',
  tools: ['WebSearch'],
  model: 'haiku',
};

const ANALYST: AgentDefinition = {
  description:
    'Data analyst. Use when you need to perform calculations, data processing, or generate statistics from research findings.',
  prompt:
    'You are a data analyst. Use Bash with python3 to perform calculations or data processing. Provide clear numerical results. Keep your response concise.',
  tools: ['Bash'],
  model: 'haiku',
};

const WRITER: AgentDefinition = {
  description:
    'Report writer. Use when you need to synthesize research findings and analysis into a clear, well-structured summary report.',
  prompt:
    'You are a report writer. Synthesize the information provided into a clear, well-structured summary. Use bullet points and headers. Keep the report concise and under 300 words.',
  tools: [],
  model: 'haiku',
};

// ── Pipeline ──────────────────────────────────────────────────────────────────
async function runResearch(topic: string): Promise<string> {
  return observe({ name: 'research_pipeline', type: 'agent' }, async () => {
    let resultText = '';
    for await (const message of claudeAgentSDK.query({
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
        // bypassPermissions auto-approves all tool calls. Demo-only — do NOT
        // use this in production code that touches real systems.
        permissionMode: 'bypassPermissions',
        agents: { researcher: RESEARCHER, analyst: ANALYST, writer: WRITER },
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
  'What is Model Context Protocol (MCP) and why does it matter?',
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
