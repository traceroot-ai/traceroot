/**
 * Vercel AI SDK Agent — Streaming Handler with Deferred Work (TraceRoot)
 *
 * A multi-phase research assistant exposed as a streaming HTTP handler
 * (`POST /api/chat`): the handler returns its response stream to the client
 * after a fraction of a second, while the real work keeps running in a detached
 * async context for much longer.
 *
 * That real work is a deep, fanned-out pipeline — a good trace to explore:
 *
 *   POST /api/chat                 (returns the stream early)
 *   └─ chat.turn                   (the detached agent turn)
 *      ├─ ai.streamText            (streamed intro)
 *      ├─ research_phase           (tool)
 *      │   └─ analyze_topic        ×N topics, in parallel
 *      │       ├─ ai.generateText  (topic overview)
 *      │       └─ deep_dive        (nested tool)
 *      │           └─ answer_subquestion ×M, in parallel
 *      │               └─ ai.generateText
 *      └─ ai.generateText          (final synthesis)
 *
 * Because the root request span finishes long before its descendants, the tree
 * view shows the full hierarchy while the timeline shows how much work happens
 * *after* the HTTP response was already streamed back. Contrast with agent.ts,
 * where the root `observe()` awaits all child work.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo:streaming
 *   # or: npx tsx agent-streaming.ts
 */

import 'dotenv/config';

import { generateText, streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

TraceRoot.initialize();
console.log('[Observability: TraceRoot]');

// How long the simulated streaming handler "stays open" before returning its
// response stream to the client. This is what makes the root span short relative
// to the work that continues behind it.
const STREAM_OPEN_MS = 250;

// Topics researched in parallel; each is summarized and then deep-dived.
const TOPICS = [
  'serverless cold starts',
  'vector database indexing',
  'streaming token latency',
  'multi-region failover',
];

// Sub-questions asked (in parallel) for each topic during its deep dive.
const SUBQUESTIONS = ['root causes', 'mitigations', 'trade-offs'];

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Deepest level: answer every sub-question for a topic with its own LLM call,
 * in parallel. Each generateText emits authentic Vercel AI SDK spans
 * (ai.generateText -> ai.generateText.doGenerate), nested under this tool span.
 */
async function deepDive(topic: string): Promise<string[]> {
  return observe({ name: 'deep_dive', type: 'tool' }, async () =>
    Promise.all(
      SUBQUESTIONS.map((question) =>
        observe({ name: 'answer_subquestion', type: 'span' }, async () => {
          const { text } = await generateText({
            model: openai('gpt-4o-mini'),
            experimental_telemetry: {
              isEnabled: true,
              functionId: `subquestion_${topic}_${question}`.replace(/\s+/g, '_'),
            },
            system: 'You are a precise systems engineer. Answer in 2-3 sentences.',
            prompt: `Topic: ${topic}\nQuestion: what are the ${question}?`,
          });
          return `${question}: ${text.trim()}`;
        }),
      ),
    ),
  );
}

/**
 * Middle level: write a one-paragraph overview of a topic, then deep-dive into
 * it (a nested tool, adding depth to the trace).
 */
async function analyzeTopic(topic: string): Promise<string> {
  return observe({ name: 'analyze_topic', type: 'span' }, async () => {
    const { text: summary } = await generateText({
      model: openai('gpt-4o-mini'),
      experimental_telemetry: { isEnabled: true, functionId: `summary_${topic}`.replace(/\s+/g, '_') },
      system: 'You are a staff engineer. Give a one-paragraph overview.',
      prompt: `Give an overview of: ${topic}`,
    });
    const details = await deepDive(topic);
    return `## ${topic}\n${summary.trim()}\nDetails:\n${details.join('\n')}`;
  });
}

/**
 * Research phase: analyze every topic in parallel.
 */
async function researchPhase(): Promise<string[]> {
  return observe({ name: 'research_phase', type: 'tool' }, async () =>
    Promise.all(TOPICS.map((topic) => analyzeTopic(topic))),
  );
}

/**
 * The actual agent turn: stream an intro, run the parallel research fan-out, and
 * synthesize a final brief. This is the work that keeps running after the HTTP
 * root span has already returned its stream.
 */
async function runChatTurn(query: string): Promise<string> {
  return observe({ name: 'chat.turn', type: 'agent' }, async () => {
    const stream = streamText({
      model: openai('gpt-4o-mini'),
      experimental_telemetry: { isEnabled: true, functionId: 'chat_turn' },
      system:
        'You are a research assistant. Briefly acknowledge the request and say ' +
        'you are gathering material, then wait for the research before answering.',
      prompt: query,
    });

    let intro = '';
    for await (const chunk of stream.textStream) {
      intro += chunk;
    }

    const analyses = await researchPhase();

    const { text: synthesis } = await generateText({
      model: openai('gpt-4o-mini'),
      experimental_telemetry: { isEnabled: true, functionId: 'synthesis' },
      system: 'You are a principal engineer writing a crisp executive summary.',
      prompt:
        `User request: ${query}\n\n` +
        `Using these analyses, write a 2-paragraph brief and then recommend where to invest first with a clear ranking.\n\n` +
        analyses.join('\n\n'),
    });

    return `${intro}\n\n${analyses.join('\n\n')}\n\n# Summary\n${synthesis.trim()}`;
  });
}

/**
 * Simulates `POST /api/chat`: a Vercel AI SDK route handler that returns a
 * streamed response and then keeps working. The root span ends after
 * STREAM_OPEN_MS while `runChatTurn` runs detached in the same trace.
 *
 * Returns the background promise so main() can await full completion before
 * flushing/exporting (the process must stay alive until the real spans finish;
 * the root span is still short).
 */
async function handleChatRequest(query: string): Promise<string> {
  let turnPromise!: Promise<string>;

  await observe({ name: 'POST /api/chat', type: 'span' }, async () => {
    // Kick off the real work WITHOUT awaiting it. The synchronous prefix of
    // runChatTurn opens `chat.turn` while this root span is still the active
    // context, so it (and everything under it) is parented to this root and
    // shares its traceId.
    turnPromise = runChatTurn(query);

    // Simulate "stream opened / first byte sent → handler returns". The root
    // span ends here, long before turnPromise resolves.
    await delay(STREAM_OPEN_MS);
  });

  // Root span has now ended. Finish the detached work so spans actually export.
  return turnPromise;
}

async function main() {
  const query =
    'Research common reliability problems in modern AI inference platforms and ' +
    'recommend where to invest first.';

  try {
    await usingAttributes(
      { userId: 'example-user', sessionId: 'vercel-ai-streaming-session' },
      async () => {
        console.log('='.repeat(60));
        console.log('Vercel AI SDK Agent — Streaming Handler with Deferred Work');
        console.log('='.repeat(60));
        console.log(`Query: ${query}\n`);

        const result = await handleChatRequest(query);

        console.log('\nAgent result:\n' + result);
      },
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('\n[Traces exported]');
    console.log(
      'Open the trace in the UI: the root POST /api/chat span ends ~' +
      STREAM_OPEN_MS +
      'ms in (the streamed response), while chat.turn and the whole research ' +
      'fan-out keep running well after — all under the same trace.',
    );
  }
}

main().catch(console.error);
