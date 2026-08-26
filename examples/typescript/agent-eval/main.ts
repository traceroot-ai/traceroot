/**
 * Offline eval for the tool agent: three scorers over the dataset, one run.
 *
 * Run: `cp .env.example .env`, `pnpm install`, `pnpm start`.
 * With no TRACEROOT_API_KEY set the run stays local and reports nowhere.
 */

import 'dotenv/config';

import { TraceRoot, Dataset, evaluate, Scorer, type ScorerContext } from '@traceroot-ai/traceroot';

import { runAgent, type AgentResult } from './agent';
import { dataset, mentions } from './dataset';

// No TraceRoot key (or the unedited .env.example placeholder)? Run fully local.
const apiKey = (process.env.TRACEROOT_API_KEY ?? '').trim();
const LOCAL = apiKey === '' || apiKey === 'your_traceroot_api_key_here';

// Initialize TraceRoot (traces the agent's AI SDK calls + reports the run) only when a
// real key is present; in local mode it stays off so a keyless clone emits/exports nothing.
if (!LOCAL) TraceRoot.initialize();

interface Expected {
  tools: string[];
  facts: number[];
}

// ── Scorers ─────────────────────────────────────────────────────────────────

const callsExpectedTools = Scorer.code(
  {
    name: 'calls_expected_tools',
    key: 'calls_expected_tools',
    valueType: 'numeric',
    direction: 'higher_is_better',
    threshold: 1.0,
  },
  (ctx: ScorerContext) => {
    const expected = (ctx.expected as Expected).tools;
    const used = new Set((ctx.output as AgentResult).toolsUsed ?? []);
    if (expected.length === 0) return 1.0;
    return expected.filter((t) => used.has(t)).length / expected.length;
  },
);

const reportsExpectedFacts = Scorer.code(
  {
    name: 'reports_expected_facts',
    key: 'reports_expected_facts',
    valueType: 'numeric',
    direction: 'higher_is_better',
    threshold: 1.0,
  },
  (ctx: ScorerContext) => {
    const facts = (ctx.expected as Expected).facts;
    const answer = (ctx.output as AgentResult).answer ?? '';
    if (facts.length === 0) return 1.0;
    return facts.filter((f) => mentions(answer, f)).length / facts.length;
  },
);

const answerIsGrounded = Scorer.llmJudge({
  name: 'answer_is_grounded',
  model: 'gpt-4o-mini',
  messages: [
    {
      role: 'system',
      content:
        'You grade whether an ANSWER gives concrete, specific values for the TASK. ' +
        'Reply with exactly 1.0 if the answer states concrete numbers that address ' +
        'the task, or 0.0 if it is empty, hedged, or refuses. Reply with only the number.',
    },
    { role: 'user', content: 'TASK:\n{{input}}\n\nANSWER:\n{{output}}' },
  ],
  valueType: 'numeric',
  threshold: 1.0,
});

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  try {
    const result = await evaluate({
      name: 'Agent tool eval',
      dataset: dataset(),
      task: (input) => runAgent(input as { question: string }),
      scorers: [callsExpectedTools, reportsExpectedFacts, answerIsGrounded],
      candidateVersion: 'gpt-4o-mini',
      evaluationKey: 'agent-tool-eval',
      local: LOCAL,
    });
    console.log(result.summary());

    const url = result.uploadState?.dashboardUrl;
    if (url) {
      console.log(`\nView the run: ${url}`);
    }
  } finally {
    await TraceRoot.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
