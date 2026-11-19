/**
 * Vercel AI SDK — ToolLoopAgent + friends, all traced by TraceRoot
 *
 * TraceRoot's Vercel AI SDK integration works at the OpenTelemetry layer: it
 * enriches the spans the AI SDK emits when `experimental_telemetry: { isEnabled:
 * true }` is set, rather than wrapping any single function. Every core function
 * is traced on equal footing — including the `ToolLoopAgent` class, which is
 * itself a thin wrapper over generateText/streamText and therefore emits the
 * exact same spans.
 *
 * This example demonstrates that by exercising FOUR distinct AI SDK surfaces in
 * one run, framed as a small customer-support triage assistant:
 *
 *   support_ticket                       (observe: agent)
 *   ├─ route_query                       (observe: span)
 *   │   ├─ ai.embedMany.doEmbed          (embed the knowledge base)
 *   │   └─ ai.embed.doEmbed              (embed the incoming question)
 *   ├─ ai.generateText / .doGenerate     (ToolLoopAgent.generate — the tool loop)
 *   │   └─ ai.toolCall  ×N               (getOrderStatus / getRefundPolicy / calculate)
 *   └─ ai.generateObject.doGenerate      (schema-validated triage record)
 *
 * Plus a separate streaming demo using the SAME agent's `.stream()` method.
 *
 * ── On observe() and span input/output ──────────────────────────────────────
 * observe(options, fn, ...args) auto-captures the ARGS you pass as the span's
 * input and the return value as its output. If you wrap a zero-arg closure —
 * observe({...}, async () => {...}) — there are no args, so the span records NO
 * input (only output). We therefore pass the real arguments through, e.g.
 * observe({ name: 'support_ticket', type: 'agent' }, handler, question).
 *
 * Note: the AI SDK already emits an `ai.toolCall` span per tool with args+result
 * captured, so tool `execute` bodies do NOT need their own observe() wrapper —
 * doing so just creates an empty-input duplicate span. We let the AI SDK trace
 * the tools natively.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo:agent
 *   # or: npx tsx tool-loop-agent.ts
 */

import 'dotenv/config';

import {
  ToolLoopAgent,
  generateObject,
  embed,
  embedMany,
  cosineSimilarity,
  tool,
  stepCountIs,
} from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
// No instrumentModules needed — Vercel AI SDK telemetry is handled automatically
// via the OpenInference span processor registered inside TraceRoot.initialize().
// Every AI SDK call below just sets experimental_telemetry: { isEnabled: true }.
TraceRoot.initialize();
console.log('[Observability: TraceRoot]');

const LLM = openai('gpt-4o-mini');
const EMBEDDINGS = openai.embedding('text-embedding-3-small');

// ── Mock data (stands in for a real orders / policy backend) ────────────────────

const orderDb: Record<string, { status: string; total: number; eta: string }> = {
  'A-1001': { status: 'shipped', total: 129.99, eta: '2 days' },
  'A-1002': { status: 'processing', total: 58.5, eta: '5 days' },
  'A-1003': { status: 'delivered', total: 412.0, eta: 'delivered' },
};

// A tiny "knowledge base" we route against with embeddings (semantic routing).
const KNOWLEDGE_BASE = [
  {
    topic: 'orders',
    text: 'Track an order, check shipping status, delivery estimates, and where a package currently is.',
  },
  {
    topic: 'refunds',
    text: 'Refund eligibility, return windows, how to start a return, and how long refunds take to process.',
  },
  {
    topic: 'billing',
    text: 'Charges, invoices, payment methods, taxes, discounts, and disputing an incorrect amount.',
  },
];

// ── ToolLoopAgent ───────────────────────────────────────────────────────────────
// The centerpiece. `ToolLoopAgent` (v6; formerly `Experimental_Agent` / `Agent`)
// runs the model → tool → model loop for you. Under the hood it calls
// generateText/streamText, so it emits the identical OpenTelemetry spans and is
// traced by TraceRoot with zero extra setup.
//
// The tool `execute` bodies are NOT wrapped in observe(): the AI SDK already emits
// an `ai.toolCall` span for each with the args as input and the return value as
// output. Wrapping them again would just add an empty-input duplicate span.

const SUPPORT_INSTRUCTIONS = `You are "Ferry", a concise, reliable customer-support agent.
You have exactly three tools: getOrderStatus, getRefundPolicy, and calculate.
Always obtain order facts and policy text from the tools — never invent them.
Route arithmetic (e.g. applying a restocking fee) through calculate so it is auditable.
When you have enough information, answer in 2-4 short sentences of clean prose. No emoji.`;

const supportAgent = new ToolLoopAgent({
  model: LLM,
  instructions: SUPPORT_INSTRUCTIONS,
  // Stop after at most 5 model steps (loop iterations). Default would be 20.
  stopWhen: stepCountIs(5),
  // ↓ This single line makes the agent's underlying generateText/streamText calls
  // emit Vercel AI SDK OpenTelemetry spans. TraceRoot enriches them automatically.
  experimental_telemetry: { isEnabled: true, functionId: 'support_agent' },
  tools: {
    getOrderStatus: tool({
      description: 'Look up the status, total, and ETA for an order id (e.g. A-1001)',
      inputSchema: z.object({ orderId: z.string().describe('Order id like A-1001') }),
      execute: async ({ orderId }) => {
        const data = orderDb[orderId.toUpperCase()];
        return data ? { orderId, ...data } : { orderId, error: 'not found' };
      },
    }),
    getRefundPolicy: tool({
      description: 'Get the refund/return policy for a product category',
      inputSchema: z.object({
        category: z.enum(['electronics', 'apparel', 'default']).describe('Product category'),
      }),
      execute: async ({ category }) => {
        const policies: Record<string, string> = {
          electronics: '30-day returns; 15% restocking fee on opened items.',
          apparel: '45-day returns; free, no restocking fee.',
          default: '30-day returns; no restocking fee.',
        };
        return { category, policy: policies[category] ?? policies.default };
      },
    }),
    calculate: tool({
      description: 'Evaluate a simple arithmetic expression (digits and + - * / . () only)',
      inputSchema: z.object({ expression: z.string().describe("e.g. '129.99 * 0.15'") }),
      execute: async ({ expression }) => {
        if (!/^[\d\s+\-*/().]+$/.test(expression)) {
          return { error: `Unsupported expression: ${expression}` };
        }
        try {
          // eslint-disable-next-line no-new-func
          const result = Function(`"use strict"; return (${expression})`)() as number;
          return { expression, result };
        } catch {
          return { error: `Invalid expression: ${expression}` };
        }
      },
    }),
  },
});

// ── Structured-output schema (generateObject) ───────────────────────────────────
// After the agent answers, we extract a schema-validated triage record. This
// exercises generateObject, which TraceRoot also traces natively.

const triageSchema = z.object({
  category: z.enum(['orders', 'refunds', 'billing', 'other']),
  priority: z.enum(['low', 'medium', 'high']),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  needsHuman: z.boolean(),
  summary: z.string().describe('One-sentence summary of the resolution'),
});

// ── Steps ───────────────────────────────────────────────────────────────────────

/**
 * Semantic routing with embeddings: embed the KB topics once, embed the incoming
 * question, and pick the closest topic by cosine similarity. Exercises embedMany,
 * embed, and cosineSimilarity — all traced.
 *
 * `question` is passed as an observe() arg so the route_query span records it as input.
 */
async function routeQuery(question: string): Promise<{ topic: string; score: number }> {
  return observe(
    { name: 'route_query', type: 'span' },
    async (q: string) => {
      const { embeddings } = await embedMany({
        model: EMBEDDINGS,
        values: KNOWLEDGE_BASE.map((k) => k.text),
        experimental_telemetry: { isEnabled: true, functionId: 'kb_embed' },
      });
      const { embedding: queryVec } = await embed({
        model: EMBEDDINGS,
        value: q,
        experimental_telemetry: { isEnabled: true, functionId: 'query_embed' },
      });

      let best = { topic: KNOWLEDGE_BASE[0].topic, score: -Infinity };
      embeddings.forEach((vec, i) => {
        const score = cosineSimilarity(queryVec, vec);
        if (score > best.score) best = { topic: KNOWLEDGE_BASE[i].topic, score };
      });
      console.log(`   routed to "${best.topic}" (score ${best.score.toFixed(3)})`);
      return best;
    },
    question,
  );
}

/** Extract a schema-validated triage record from the agent's answer. */
async function extractTriage(question: string, answer: string, topic: string) {
  const { object } = await generateObject({
    model: LLM,
    schema: triageSchema,
    experimental_telemetry: { isEnabled: true, functionId: 'triage_extract' },
    prompt:
      `Produce a triage record for this support interaction.\n` +
      `Routed topic: ${topic}\n\nCustomer: ${question}\n\nAgent answer: ${answer}`,
  });
  return object;
}

/**
 * Full non-streaming ticket: route → agent.generate (tool loop) → structured triage.
 * `question` is passed as an observe() arg so the support_ticket span records it as input.
 */
async function handleTicket(question: string) {
  return observe(
    { name: 'support_ticket', type: 'agent' },
    async (q: string) => {
      const route = await routeQuery(q);

      const result = await supportAgent.generate({
        prompt: `Relevant area: ${route.topic}\n\nCustomer question: ${q}`,
      });

      const triage = await extractTriage(q, result.text, route.topic);

      const u = result.usage;
      console.log(
        `   usage → input=${u.inputTokens} output=${u.outputTokens} total=${u.totalTokens} ` +
          `| steps=${result.steps.length}`,
      );
      return { answer: result.text, triage };
    },
    question,
  );
}

/** Streaming variant using the SAME agent's .stream() method. */
async function handleTicketStreaming(question: string): Promise<string> {
  return observe(
    { name: 'support_ticket_streaming', type: 'agent' },
    async (q: string) => {
      const stream = await supportAgent.stream({
        prompt: `Customer question: ${q}`,
      });

      let answer = '';
      process.stdout.write('   streaming: ');
      for await (const chunk of stream.textStream) {
        answer += chunk;
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');
      return answer;
    },
    question,
  );
}

// ── Demo ──────────────────────────────────────────────────────────────────────

async function main() {
  const tickets = [
    "Where's my order A-1001, and when will it arrive?",
    "I opened my A-1003 electronics order — if I return it, what's the restocking fee on the $412 total?",
  ];
  const streamingTicket = 'Can I return apparel I bought 3 weeks ago?';

  try {
    await usingAttributes(
      { userId: 'example-user', sessionId: 'vercel-ai-tool-loop-agent-session' },
      () =>
        // Pass the ticket list as an observe() arg so demo_session records it as input.
        observe(
          { name: 'demo_session', type: 'agent' },
          async (allTickets: string[]) => {
            console.log('='.repeat(60));
            console.log('Vercel AI SDK — ToolLoopAgent + generateObject + embeddings');
            console.log('='.repeat(60));

            for (let i = 0; i < allTickets.length; i++) {
              const question = allTickets[i];
              console.log(`\n${'='.repeat(60)}`);
              console.log(`Ticket ${i + 1}: ${question}`);
              console.log('='.repeat(60));
              const { answer, triage } = await handleTicket(question);
              console.log('\nAgent: ' + answer);
              console.log('Triage: ' + JSON.stringify(triage));
            }

            // Streaming demo on one more ticket, reusing the same agent.
            console.log(`\n${'='.repeat(60)}`);
            console.log('Streaming demo (agent.stream)');
            console.log('='.repeat(60));
            await handleTicketStreaming(streamingTicket);
          },
          tickets,
        ),
    );
  } finally {
    await TraceRoot.shutdown();
    console.log('\n[Traces exported]');
  }
}

main().catch(console.error);
