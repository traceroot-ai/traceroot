/**
 * LiteLLM streaming pipeline — TraceRoot generator support
 *
 * Demonstrates two patterns where observe() wraps an async generator, talking
 * to a LiteLLM proxy through the openai SDK (no native LiteLLM TS SDK exists).
 *
 *   1. Direct streaming   — observe() on a generator that yields raw tokens
 *                           from the proxy's streaming response.
 *   2. Pipeline streaming — a second observe() layer that transforms the token
 *                           stream before handing it to the caller.
 *
 * Why this matters for observability:
 *   Without generator support, observe() would close the span the moment the
 *   generator object is returned — before any tokens arrive. The trace would
 *   show near-zero latency and no output. With generator support the span
 *   closes only after the last token, capturing real end-to-end duration and
 *   the full assembled output.
 *
 * Span hierarchy produced:
 *   streaming_demo (agent)
 *   └─ run_query (agent)  ×2
 *      ├─ stream_tokens (llm)           ← Pattern 1
 *      │  └─ OpenAI LLM span (auto)
 *      └─ transform_stream (span)       ← Pattern 2
 *         └─ stream_tokens (llm)
 *            └─ OpenAI LLM span (auto)
 *
 * Prerequisites:
 *   1. Start the proxy in another terminal:
 *        uv tool install 'litellm[proxy]'   # or: pip install 'litellm[proxy]'
 *        litellm --model gpt-3.5-turbo
 *   2. Env vars: LITELLM_PROXY_URL, LITELLM_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm streaming
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });

const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY ?? 'sk-1234',
  baseURL: process.env.LITELLM_PROXY_URL ?? 'http://0.0.0.0:4000',
});
console.log('[Observability: TraceRoot — LiteLLM streaming pipeline]');

// Must match the model your LiteLLM proxy is serving. Default matches the
// `litellm --model gpt-3.5-turbo` quick start.
const MODEL = 'gpt-3.5-turbo';

// ---------------------------------------------------------------------------
// Pattern 1: direct streaming
//
// streamTokens is an async generator wrapped with observe().
// The span stays open while tokens are flowing and closes after the last
// chunk, capturing total latency and the assembled output.
// ---------------------------------------------------------------------------

async function* streamTokens(prompt: string) {
  const stream = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
  });
  for await (const chunk of stream) {
    const token = chunk.choices[0]?.delta?.content;
    if (token) yield token;
  }
}

// ---------------------------------------------------------------------------
// Pattern 2: pipeline streaming
//
// transformStream wraps streamTokens and applies a transformation to each
// token. Both are observed generators, so TraceRoot creates two spans:
// transform_stream as parent, stream_tokens as child. The parent span closes
// only after all transformed tokens are consumed.
// ---------------------------------------------------------------------------

async function* transformStream(prompt: string, uppercase = false) {
  for await (const token of observe({ name: 'stream_tokens', type: 'llm' }, streamTokens, prompt)) {
    yield uppercase ? token.toUpperCase() : token;
  }
}

// ---------------------------------------------------------------------------
// Agent: runs both patterns for a given query
// ---------------------------------------------------------------------------

async function runQuery(query: string) {
  return observe({ name: 'run_query', type: 'agent' }, async () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Query: ${query}`);
    console.log('='.repeat(60));

    // Pattern 1: direct stream
    console.log('\n[Pattern 1 — direct stream]');
    process.stdout.write('Response: ');
    for await (const token of observe({ name: 'stream_tokens', type: 'llm' }, streamTokens, query)) {
      process.stdout.write(token);
    }
    console.log();

    // Pattern 2: pipeline stream (uppercase transform)
    console.log('\n[Pattern 2 — pipeline stream, uppercased]');
    process.stdout.write('Response: ');
    for await (const token of observe(
      { name: 'transform_stream', type: 'span' },
      transformStream,
      query,
      true,
    )) {
      process.stdout.write(token);
    }
    console.log();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEMO_QUERIES = [
  'In one sentence, what is observability?',
  'In one sentence, why does latency matter in LLM apps?',
];

async function main() {
  try {
    await usingAttributes(
      { sessionId: 'litellm-streaming-pipeline-demo', userId: 'example-user' },
      () =>
        observe({ name: 'streaming_demo', type: 'agent' }, async () => {
          for (const query of DEMO_QUERIES) {
            await runQuery(query);
          }
        }),
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('\n[Traces exported]');
  }
}

main().catch(console.error);
