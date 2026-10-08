/* eslint-disable */
/**
 * Sourced doc snippets for TraceRoot TypeScript SDK and Tracing documentation.
 *
 * These snippets are extracted by scripts/sync_doc_snippets.py into docs/snippets/
 * and synced into docs/tracing/*.mdx. CI verifies they do not drift.
 */

// [start:tracing-get-started-typescript]
import OpenAI from 'openai';
import { TraceRoot } from '@traceroot-ai/traceroot';

// This single line instruments all OpenAI API calls
TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });

const openai = new OpenAI();
// [end:tracing-get-started-typescript]

// [start:tracing-cost-tracking-typescript]
import OpenAI from 'openai';
import { TraceRoot } from '@traceroot-ai/traceroot';

TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });

const client = new OpenAI();

// All OpenAI calls are now automatically tracked — tokens, cost, model
await client.chat.completions.create({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Hello!' }],
});
// [end:tracing-cost-tracking-typescript]

// [start:typescript-sdk-init]
import OpenAI from 'openai';
import { TraceRoot } from '@traceroot-ai/traceroot';

TraceRoot.initialize({
  instrumentModules: { openAI: OpenAI },
});

const openai = new OpenAI();
// [end:typescript-sdk-init]

// [start:typescript-sdk-observe]
import { observe } from '@traceroot-ai/traceroot';

const result = await observe({ name: 'my_function', type: 'tool' }, async () => {
  return 'your result here';
});
// [end:typescript-sdk-observe]
