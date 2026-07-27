/**
 * Pi Coding Agent SDK — TraceRoot Observability
 *
 * `@earendil-works/pi-coding-agent` is the library form of the `pi` coding
 * agent: instead of an interactive CLI, you drive an `AgentSession` from your
 * own Node process and it reads/writes files and runs shell commands in a
 * real working directory. `TraceRoot.initialize()` instruments `AgentSession`
 * so every session — however it was constructed — is traced with full
 * agent/LLM/tool span semantics, no manual span code required.
 *
 * This demo plays out a small on-call incident end-to-end on ONE persistent
 * `AgentSession`, narrowing and widening its tool set between phases instead
 * of recreating the session (see "One session, changing tool sets" in the
 * README for why that's possible, and why the session must be created
 * without a `tools` allowlist for it to work):
 *
 *   incident_inv_2041                        (observe: agent)
 *   ├─ recon                                 (observe: span) — read-only tools
 *   │   ├─ AGENT  prompt 1: map the repo
 *   │   │   └─ TOOL  ls, find
 *   │   └─ AGENT  prompt 2: investigate the overcharge
 *   │       └─ TOOL  grep, read, read (ERROR — config/pricing.json is missing)
 *   ├─ remediate                             (observe: span) — full tool set
 *   │   └─ AGENT  prompt 3: reproduce, fix, verify
 *   │       └─ TOOL  bash (ERROR — failing test), edit, bash
 *   └─ report                                (observe: span)
 *       └─ AGENT  prompt 4: write POSTMORTEM.md
 *           └─ TOOL  write
 *
 * Span count: 4 custom (root + 3 phases) + 4 AGENT (one per session.prompt()
 * call) + 9 TOOL (ls, find, grep, read, read-ERROR, bash-ERROR, edit, bash,
 * write — all 7 builtin tool types, 2 genuine ERROR spans) + roughly 7-13 LLM
 * spans (one per model turn; fewer if the model batches several tool calls
 * into a single turn) ≈ 24-30 spans total.
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import * as pi from '@earendil-works/pi-coding-agent';
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { TraceRoot, observe, usingAttributes } from '@traceroot-ai/traceroot';

// One call wires the pi instrumentation (via instrumentModules.piCodingAgent)
// and registers the OpenTelemetry pipeline. It must run BEFORE
// createAgentSession() below, because wiring pi patches AgentSession's
// prototype. The pi spans and the observe()/usingAttributes() spans this file
// creates directly all flow through that one pipeline, flushed by the
// TraceRoot.shutdown() call at the bottom. apiKey falls back to
// TRACEROOT_API_KEY when omitted.
TraceRoot.initialize({
  instrumentModules: { piCodingAgent: pi },
});

console.log('[Observability: TraceRoot]');

// The agent operates on a real directory. Use a scratch workspace next to
// this script rather than process.cwd() so the demo's file writes stay
// self-contained and don't touch wherever `pnpm demo` happens to run from.
const workspace = join(fileURLToPath(new URL('.', import.meta.url)), 'workspace');
rmSync(workspace, { recursive: true, force: true });
mkdirSync(join(workspace, 'src'), { recursive: true });
mkdirSync(join(workspace, 'test'), { recursive: true });

// Mark the workspace CommonJS so the seeded require()-based source and test
// files run under `node` without hitting a module-type error.
writeFileSync(
  join(workspace, 'package.json'),
  JSON.stringify({ name: 'checkout-pricing', private: true, type: 'commonjs' }, null, 2),
);

writeFileSync(
  join(workspace, 'README.md'),
  '# checkout-pricing\n\n' +
    'Order-total calculation for a storefront checkout: sum item prices into a\n' +
    'subtotal, then apply an optional coupon (flat-amount or percent-off) on top.\n',
);

// PLANTED BUG: the flat branch adds the coupon amount instead of subtracting
// it, so a flat coupon *increases* the total — this is incident INV-2041. The
// percent branch is correct. The config/pricing.json reference below is a
// realistic dangling pointer (per-store overrides would live there if a store
// had customized its coupon rules; none exists in this workspace), giving
// recon a genuine tool error to hit rather than a staged one.
writeFileSync(
  join(workspace, 'src', 'pricing.js'),
  `'use strict';

// Per-store discount overrides, when a store has customized coupon rules,
// live in config/pricing.json. Most stores don't have one and use these
// defaults.
function applyCoupon(subtotal, coupon) {
  if (coupon.type === 'flat') {
    return subtotal + coupon.amount;
  }
  if (coupon.type === 'percent') {
    return subtotal * (1 - coupon.amount / 100);
  }
  throw new Error(\`Unknown coupon type: \${coupon.type}\`);
}

module.exports = { applyCoupon };
`,
);

writeFileSync(
  join(workspace, 'src', 'cart.js'),
  `'use strict';

const { applyCoupon } = require('./pricing');

// Sums item prices and applies an optional coupon to get the cart total.
function cartTotal(items, coupon) {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  return coupon ? applyCoupon(subtotal, coupon) : subtotal;
}

module.exports = { cartTotal };
`,
);

// Plain assert — no test runner needed for a two-assertion smoke test, and an
// uncaught throw from assert.strictEqual exits the process with a nonzero
// code, which is all the demo needs for a genuine ERROR-status bash span.
writeFileSync(
  join(workspace, 'test', 'pricing.test.js'),
  `'use strict';

const assert = require('node:assert');
const { applyCoupon } = require('../src/pricing');

// $20 flat off a $100 subtotal should total $80. Fails today: the bug adds
// the coupon amount instead of subtracting it.
assert.strictEqual(applyCoupon(100, { type: 'flat', amount: 20 }), 80);

// 10% off a $100 subtotal should total $90 — already correct, kept here so a
// green run proves the fix didn't just special-case the flat branch.
assert.strictEqual(applyCoupon(100, { type: 'percent', amount: 10 }), 90);

console.log('pricing tests passed');
`,
);

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);
const model = modelRegistry.find('openai', 'gpt-4o-mini');
if (!model) {
  // find() only checks pi's static built-in model list, not auth — gpt-4o-mini is
  // always in that list, so this would only fire if pi renames/drops the model id.
  throw new Error('gpt-4o-mini is not a known model id in this version of pi-coding-agent.');
}
if (!modelRegistry.hasConfiguredAuth(model)) {
  throw new Error(
    'No OpenAI credentials found. Set OPENAI_API_KEY in your environment (pi falls back to it ' +
      "when there's no `pi auth login` credential on disk).",
  );
}

/** subscribe() surfaces tool calls and assistant messages as they happen — useful
 *  for demo output, and independent of what gets traced. TraceRoot observes the
 *  same session through the prototype patch, not this listener. */
function logEvents(session: AgentSession): void {
  session.subscribe((event) => {
    switch (event.type) {
      case 'tool_execution_start':
        console.log(`   tool → ${event.toolName} ${JSON.stringify(event.args)}`);
        break;
      case 'tool_execution_end':
        console.log(`   tool ← ${event.toolName}${event.isError ? ' (error)' : ''}`);
        break;
      case 'message_end': {
        const { message } = event;
        if (message.role === 'assistant') {
          const text = message.content.find((c) => c.type === 'text')?.text;
          if (text) console.log(`   assistant: ${text.slice(0, 300)}`);
        }
        break;
      }
      default:
        break;
    }
  });
}

const INCIDENT_SUMMARY =
  'Incident INV-2041: storefront checkout is overcharging customers who apply coupons.';

const RECON_PROMPTS: readonly [string, string] = [
  'Map the repo: use ls on the project root, then find to locate every .js file. ' +
    'Briefly describe the project layout — no need to read file contents yet.',
  `${INCIDENT_SUMMARY} Flat-amount coupons appear to increase the total instead of ` +
    'reducing it. grep for coupon-related code, then read src/pricing.js. Also check ' +
    'whether this store has a per-store override by reading config/pricing.json — if ' +
    "that read fails, report the exact error rather than treating it as fatal. Give me " +
    'your working theory of the bug.',
];

const REMEDIATE_PROMPT =
  'Reproduce, fix, and verify. First run `node test/pricing.test.js` and tell me exactly ' +
  'how it fails. Then make the minimal fix to src/pricing.js using the edit tool. Then ' +
  're-run the same test and confirm it now passes.';

const REPORT_PROMPT =
  'Write POSTMORTEM.md in this directory documenting INV-2041: root cause, the fix ' +
  'applied, and how it was verified. Keep it short — a few short sections, not an essay.';

/**
 * Read-only investigation. The agent physically cannot write, edit, or run
 * shell commands here — enforced by tool availability rather than prompt
 * engineering. Two prompts, one span: mapping the repo and diagnosing the
 * bug are both "look, don't touch" work.
 */
async function recon(session: AgentSession, prompts: readonly [string, string]): Promise<void> {
  return observe(
    { name: 'recon', type: 'span' },
    async ([mapPrompt, investigatePrompt]: readonly [string, string]) => {
      await session.prompt(mapPrompt);
      await session.prompt(investigatePrompt);
    },
    prompts,
  );
}

/**
 * Widen to the full tool set and let the agent reproduce, fix, and verify.
 * setActiveToolsByName() takes effect on the NEXT turn — the session.prompt()
 * call below — not retroactively; recon's already-completed turns keep
 * whatever tool set was active when they ran.
 */
async function remediate(session: AgentSession, prompt: string): Promise<void> {
  session.setActiveToolsByName(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
  return observe({ name: 'remediate', type: 'span' }, (p: string) => session.prompt(p), prompt);
}

/** Document the incident. The write tool is already active from remediate(). */
async function report(session: AgentSession, prompt: string): Promise<void> {
  return observe({ name: 'report', type: 'span' }, (p: string) => session.prompt(p), prompt);
}

async function main(): Promise<void> {
  const { session } = await createAgentSession({
    cwd: workspace,
    model,
    authStorage,
    modelRegistry,
    // Deliberately NO `tools` option here. Passing one would permanently cap
    // the tool REGISTRY (not just the active set) to that allowlist, and
    // setActiveToolsByName() could then never widen past it later. Creating
    // with the full registry and narrowing immediately below is the only way
    // to get least-privilege recon that can still widen for the fix. See
    // "One session, changing tool sets" in the README.
  });
  logEvents(session);

  // Narrow to a read-only set before the FIRST prompt. The default active set
  // on a `tools`-less session would be read/bash/edit/write — already wider
  // than recon should have — so this line, not the omission above, is what
  // actually enforces least privilege for the recon phase.
  session.setActiveToolsByName(['ls', 'find', 'grep', 'read']);

  try {
    await usingAttributes(
      { userId: 'example-user', sessionId: 'pi-agent-sdk-incident-session' },
      () =>
        observe(
          { name: 'incident_inv_2041', type: 'agent' },
          async (summary: string) => {
            console.log(`\n--- ${summary} ---`);
            await recon(session, RECON_PROMPTS);
            await remediate(session, REMEDIATE_PROMPT);
            await report(session, REPORT_PROMPT);
          },
          INCIDENT_SUMMARY,
        ),
    );
  } finally {
    session.dispose();
    // Flush inside main()'s own finally, not a separate .finally() bolted
    // onto the call below: shutdown() can itself reject (network failure,
    // bad TRACEROOT_API_KEY, unreachable backend), and a rejection from a
    // .finally() callback on an already-caught chain becomes an unhandled
    // rejection nothing downstream consumes. Keeping it here means any
    // shutdown failure flows through the single catch() below like every
    // other error in this file. The pi instrumentation rides the pipeline
    // TraceRoot.initialize() registered, so this one call flushes both the pi
    // spans and the observe()/usingAttributes() spans created directly in this
    // file.
    await TraceRoot.shutdown();
    console.log('\n[Traces exported]');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
