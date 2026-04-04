/**
 * DeepAgents Multi-Agent Research — TraceRoot Observability
 *
 * A deepagents-powered supervisor that orchestrates a research sub-agent
 * and a critique sub-agent to produce a final report.
 * Instrumented with TraceRoot via the LangChain callback manager.
 *
 * langchain: patches the LangChain callback manager to trace all chain/LLM spans,
 * capturing the full multi-agent hierarchy.
 *
 * Env vars required: ANTHROPIC_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';
import * as lcCallbackManager from '@langchain/core/callbacks/manager';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';
TraceRoot.initialize({ instrumentModules: { langchain: lcCallbackManager } });
console.log('[Observability: TraceRoot]');

import { readFileSync, existsSync } from 'fs';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createDeepAgent, type SubAgent } from 'deepagents';
import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage } from '@langchain/core/messages';

// ── LLM ──────────────────────────────────────────────────────────────────────
const llm = new ChatAnthropic({ model: 'claude-sonnet-4-20250514', temperature: 0 });

// ── Search tool ───────────────────────────────────────────────────────────────
async function runSearch(query: string): Promise<string> {
  return `[Mock search results for: "${query}"]

1. LangGraph 0.4 (LangChain, 2025) — Stateful multi-agent orchestration with persistent checkpoints and streaming. Supports human-in-the-loop workflows.
   Source: https://blog.langchain.dev/langgraph-0-4/

2. Claude Agent SDK (Anthropic, 2025) — High-level SDK for building Claude-powered agents with tool use, memory, and computer use capabilities.
   Source: https://docs.anthropic.com/agent-sdk

3. DeepAgents (LangChain, 2025) — Framework for autonomous deep-research agents with multi-agent delegation and filesystem persistence.
   Source: https://github.com/langchain-ai/deepagentsjs

4. Mastra (2025) — TypeScript-first agent framework with built-in memory, workflow orchestration, and native OpenTelemetry observability.
   Source: https://mastra.ai

5. OpenAI Agents SDK (OpenAI, 2025) — Python/TypeScript SDK for multi-agent handoffs with built-in tracing and guardrails.
   Source: https://platform.openai.com/docs/agents`;
}

const internetSearch = tool(
  async ({ query }: { query: string }) => runSearch(query),
  {
    name: 'internet_search',
    description: 'Search the web for up-to-date information on a topic.',
    schema: z.object({ query: z.string().describe('The search query') }),
  },
);

// ── Sub-agents ────────────────────────────────────────────────────────────────
const researchSubAgent: SubAgent = {
  name: 'research-agent',
  description:
    'Researches a specific topic in depth. Call with one focused topic at a time; invoke multiple in parallel for broad queries.',
  systemPrompt:
    'You are a thorough research agent. Use internet_search to gather comprehensive, current information on the topic. Organise findings clearly and cite sources.',
  tools: [internetSearch],
};

const critiqueSubAgent: SubAgent = {
  name: 'critique-agent',
  description:
    'Reviews and critiques a research report for accuracy, completeness, and balance.',
  systemPrompt:
    'You are a critical editor. Review the research provided: identify factual gaps, potential bias, and unanswered questions. Suggest specific improvements. Be concise.',
};

// ── Supervisor agent ──────────────────────────────────────────────────────────
const supervisorPrompt = `You are a research supervisor. For each query:
1. Delegate research to research-agent (use multiple parallel calls for broad topics).
2. Send findings to critique-agent for review.
3. Incorporate the critique and write a final, well-structured report to final_report.md.

Write clear markdown with headings and source citations.`;

const supervisor = createDeepAgent({
  model: llm,
  tools: [internetSearch],
  systemPrompt: supervisorPrompt,
  subagents: [researchSubAgent, critiqueSubAgent],
});

// ── Demo ──────────────────────────────────────────────────────────────────────
const DEMO_QUERY = 'What are the latest developments in AI agent frameworks in 2025?';

async function main() {
  try {
    await usingAttributes(
      { userId: 'demo-user', sessionId: 'deepagents-ts-session' },
      () =>
        observe({ name: 'research_session', type: 'agent' }, async () => {
          console.log('='.repeat(60));
          console.log('DeepAgents Multi-Agent Research — Demo (TraceRoot)');
          console.log('='.repeat(60));
          console.log(`\nQuery: ${DEMO_QUERY}\n`);

          const result = await supervisor.invoke(
            { messages: [new HumanMessage(DEMO_QUERY)] },
            { recursionLimit: 100 },
          );

          const messages = result.messages ?? [];
          const lastMsg = messages[messages.length - 1];
          const output = lastMsg?.content ?? result;
          console.log('\n[Supervisor output]\n' + output);

          if (existsSync('final_report.md')) {
            console.log('\n[final_report.md]\n' + readFileSync('final_report.md', 'utf8'));
          }
        }),
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('[Traces exported]');
  }
}

main().catch(console.error);
