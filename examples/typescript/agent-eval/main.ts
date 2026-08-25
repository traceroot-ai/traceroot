/**
 * Offline eval for the tool agent.
 *
 * Points three scorers at the agent from `agent.ts` over the dataset in
 * `dataset.ts`, runs every case, and reports the run to TraceRoot.
 *
 * Run:
 *   cp .env.example .env   # fill in your keys
 *   pnpm install
 *   pnpm start
 *
 * No creds? This runs locally on its own: with no TRACEROOT_API_KEY set, `main()`
 * passes `local: true` to evaluate() so the eval runs in full and reports nowhere.
 */

import 'dotenv/config';

import { TraceRoot, Dataset, evaluate, Scorer, type ScorerContext } from '@traceroot-ai/traceroot';

import { runAgent, type AgentResult } from './agent';
import { dataset, mentions } from './dataset';

// Initialize TraceRoot so the agent's AI SDK calls are traced and the run reports.
TraceRoot.initialize();

interface Expected {
  tools: string[];
  facts: number[];
}

// ── Scorers ─────────────────────────────────────────────────────────────────

const callsExpectedTools = Scorer.code(
  {
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
  model: 'claude-haiku-4-5',
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
    // No TraceRoot key? Run locally — execute every case in full but report
    // nowhere — so a fresh clone works without a TraceRoot credential. The
    // unedited .env.example placeholder counts as "no key" too.
    const apiKey = (process.env.TRACEROOT_API_KEY ?? '').trim();
    const local = apiKey === '' || apiKey === 'your_traceroot_api_key_here';
    const result = await evaluate({
      name: 'Agent tool eval',
      dataset: dataset(),
      task: (input) => runAgent(input as { question: string }),
      scorers: [callsExpectedTools, reportsExpectedFacts, answerIsGrounded],
      candidateVersion: 'gpt-4o-mini',
      evaluationKey: 'agent-tool-eval',
      local,
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
