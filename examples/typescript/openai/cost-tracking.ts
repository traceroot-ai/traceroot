/**
 * OpenAI Cost Tracking Example — TraceRoot Observability
 *
 * Demonstrates automatic token counting and cost calculation using a priced model ID.
 *
 * Run:
 *   pnpm tsx cost-tracking.ts
 */

import 'dotenv/config';

// [start:tracing-cost-tracking-typescript]
import OpenAI from 'openai';
import { TraceRoot } from '@traceroot-ai/traceroot';

TraceRoot.initialize({ instrumentModules: { openAI: OpenAI } });
const client = new OpenAI();

// OpenAI calls are tracked automatically; cost requires a priced model ID
await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
// [end:tracing-cost-tracking-typescript]
