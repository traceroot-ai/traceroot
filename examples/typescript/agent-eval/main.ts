/**
 * Offline eval for the tool agent: three scorers over the dataset, one run.
 *
 * Run: `cp .env.example .env`, `pnpm install`, `pnpm start`.
 * With no TRACEROOT_API_KEY set the run stays local and reports nowhere.
 *
 * Pick the agent's model with AGENT_PROVIDER and the judge's with JUDGE_PROVIDER. You need
 * a key only for what you pick, and Jev can only judge: it returns typed answers, not text,
 * so the agent always runs on openai or anthropic.
 */

import 'dotenv/config';

import { TraceRoot, Dataset, evaluate, observe, Scorer, type ScorerContext } from '@traceroot-ai/traceroot';
import { trace } from '@opentelemetry/api';
import { TypeSafeClient, choice, type JsonValue } from '@typesafe-ai/sdk';

import { runAgent, agentProvider, agentModelId, type AgentResult } from './agent';
import { dataset, mentions } from './dataset';

// No TraceRoot key (or the unedited .env.example placeholder)? Run fully local.
const apiKey = (process.env.TRACEROOT_API_KEY ?? '').trim();
const LOCAL = apiKey === '' || apiKey === 'your_traceroot_api_key_here';

// Jev is pinned to a release (not jev-latest) so runs stay reproducible.
const JUDGE_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-opus-5',
  jev: 'jev-1.13.0',
} as const;
type JudgeProvider = keyof typeof JUDGE_MODELS;

const AGENT = agentProvider();
const judge = process.env.JUDGE_PROVIDER?.trim() || AGENT;
if (!Object.hasOwn(JUDGE_MODELS, judge)) {
  throw new Error(`JUDGE_PROVIDER must be openai, anthropic or jev, got "${judge}"`);
}
const JUDGE = judge as JudgeProvider;

// Checked with the other config, before anything starts up: the placeholder key
// constructs a client fine and then 401s on every case.
const typesafeKey = (process.env.TYPESAFE_API_KEY ?? '').trim();
if (JUDGE === 'jev' && (typesafeKey === '' || typesafeKey === 'your_typesafe_api_key_here')) {
  throw new Error('JUDGE_PROVIDER=jev needs a real TYPESAFE_API_KEY (see .env.example)');
}

// Initialize TraceRoot (traces the agent's AI SDK calls + reports the run) only when a
// real key is present; in local mode it stays off so a keyless clone emits/exports nothing.
if (!LOCAL) TraceRoot.initialize();

// Jev client, only for the Jev judge. Reads TYPESAFE_API_KEY.
const jev = JUDGE === 'jev' ? new TypeSafeClient() : null;

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
    const missing = expected.filter((t) => !used.has(t));
    return {
      name: 'calls_expected_tools',
      value: expected.length === 0 ? 1.0 : (expected.length - missing.length) / expected.length,
      comment: missing.length ? `missing: ${missing.join(', ')}` : 'all expected tools called',
    };
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
    const missing = facts.filter((f) => !mentions(answer, f));
    return {
      name: 'reports_expected_facts',
      value: facts.length === 0 ? 1.0 : (facts.length - missing.length) / facts.length,
      comment: missing.length ? `missing: ${missing.join(', ')}` : 'all expected numbers present',
    };
  },
);

const answerIsGrounded = Scorer.llmJudge({
  name: 'answer_is_grounded',
  model: JUDGE_MODELS[JUDGE],
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

// Did the answer say what the tools said? Catches a wrong price, another ticker's
// price, or "up" when the stock fell. Exact numbers stay in reports_expected_facts.
const answerSupportedByTools = Scorer.code(
  {
    name: 'answer_supported_by_tools',
    key: 'answer_supported_by_tools',
    valueType: 'categorical',
    outputType: 'classification',
    metadata: { model: JUDGE_MODELS.jev },
  },
  async (ctx: ScorerContext) => {
    const output = ctx.output as AgentResult;
    // Only what the question reads: Jev loses accuracy on state it does not need.
    const toolResults = output.toolResults.map((r) =>
      r.error ? { tool: r.tool, error: r.error } : { tool: r.tool, result: r.output },
    );
    const { answers, model, usage } = await observe(
      { name: 'jev:answer_supported_by_tools', type: 'llm', metadata: { model: JUDGE_MODELS.jev } },
      async () => {
        const response = await jev!.systemOne({
          model: JUDGE_MODELS.jev,
          state: {
            question: (ctx.input as { question: string }).question,
            // The tools take and return plain JSON.
            tool_results: toolResults as unknown as JsonValue[],
            answer: output.answer ?? '',
          },
          questions: {
            support: choice('How does `answer` relate to `tool_results`?', {
              supports: 'The answer only states values and facts that appear in the tool results.',
              contradicts:
                'The answer states something the tool results show is wrong, such as a ' +
                "different price, another ticker's price, or the wrong direction of change.",
              not_in_tools: 'The answer states something the tool results do not contain.',
              states_nothing:
                'The answer states no concrete values at all: it hedges, refuses, or is empty.',
            }),
          },
        });
        // What the backend prices a call by. Cost also needs a price for this model
        // id on the server; without one, model and tokens still land and cost stays empty.
        const span = trace.getActiveSpan();
        span?.setAttribute('traceroot.llm.model', response.model);
        span?.setAttribute('gen_ai.usage.input_tokens', response.usage.input_tokens);
        span?.setAttribute('gen_ai.usage.output_tokens', response.usage.output_tokens);
        return response;
      },
    );
    const a = answers.support;
    const probabilities = Object.entries(a.probabilities)
      .sort(([, p], [, q]) => q - p)
      .map(([label, p]) => `${label} ${p.toFixed(2)}`)
      .join(', ');
    return {
      name: 'answer_supported_by_tools',
      value: a.choice,
      comment: `confidence ${a.confidence.toFixed(2)} · ${probabilities}`,
      metadata: { model, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens },
    };
  },
);

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `[agent: ${AGENT}/${agentModelId()} | judge: ${JUDGE}/${JUDGE_MODELS[JUDGE]} | ` +
      `reporting: ${LOCAL ? 'local' : 'traceroot'}]\n`,
  );
  try {
    const result = await evaluate({
      name: 'Agent tool eval',
      dataset: dataset(),
      task: (input) => runAgent(input as { question: string }),
      scorers: [
        callsExpectedTools,
        reportsExpectedFacts,
        ...(JUDGE === 'jev' ? [answerSupportedByTools] : [answerIsGrounded]),
      ],
      candidateVersion: agentModelId(),
      evaluationKey: 'agent-tool-eval',
      local: LOCAL,
      metadata: { agentProvider: AGENT, judgeProvider: JUDGE },
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
