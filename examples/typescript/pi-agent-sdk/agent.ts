/**
 * Pi Coding Agent SDK — TraceRoot Observability
 *
 * `@earendil-works/pi-coding-agent` is the library form of the `pi` coding
 * agent: instead of an interactive CLI, you drive an `AgentSession` from your
 * own Node process and it reads/writes files and runs shell commands in a
 * real working directory. `@traceroot-ai/pi` patches `AgentSession.prototype`
 * so every session — however it was constructed — is traced with full
 * agent/LLM/tool span semantics, no manual span code required.
 *
 * Tool availability is fixed when a session is created (there's no per-prompt
 * override), so this demo uses three short-lived sessions to show the
 * distinct span shapes TraceRoot captures:
 *
 *   1. no tools available                      → AGENT → LLM only
 *   2. write a function + a test, run it        → AGENT → TOOL (write) ×2,
 *      via bash                                    AGENT → TOOL (bash)
 *   3. read a file that does not exist          → AGENT → TOOL (read), ERROR status
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
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import { instrumentPiCodingAgent } from '@traceroot-ai/pi';

// Instrument BEFORE creating any session — instrumentPiCodingAgent() patches
// AgentSession.prototype, so this must run before createAgentSession() below.
instrumentPiCodingAgent(pi, {
  apiKey: process.env.TRACEROOT_API_KEY,
});

console.log('[Observability: TraceRoot]');

// The agent operates on a real directory. Use a scratch workspace next to
// this script rather than process.cwd() so the demo's file writes stay
// self-contained and don't touch wherever `pnpm demo` happens to run from.
const workspace = join(fileURLToPath(new URL('.', import.meta.url)), 'workspace');
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
// Mark the workspace CommonJS so the agent's generated require()-based files
// (turn 2, below) run under `node` without hitting a module-type error.
writeFileSync(
  join(workspace, 'package.json'),
  JSON.stringify({ name: 'traceroot-pi-demo-workspace', private: true, type: 'commonjs' }, null, 2),
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

/** Runs one prompt on a freshly created, freshly disposed session. */
async function runTurn(prompt: string, sessionOptions: Partial<CreateAgentSessionOptions>) {
  const { session } = await createAgentSession({
    cwd: workspace,
    model,
    authStorage,
    modelRegistry,
    ...sessionOptions,
  });
  logEvents(session);
  try {
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }
}

async function main() {
  console.log('\n--- Turn 1: no tools (pure AGENT → LLM) ---');
  await runTurn('What is the capital of France? Answer in one word.', { noTools: 'all' });

  console.log('\n--- Turn 2: write a function, then write + run a test for it ---');
  await runTurn(
    'Create add.js exporting a function add(a, b) that returns a + b (CommonJS, ' +
      'module.exports). Then write test-add.js that requires add.js and asserts ' +
      'add(2, 3) === 5, run it with node, and tell me whether it passed.',
    { tools: ['write', 'bash'] },
  );

  console.log('\n--- Turn 3: tool error (read a file that does not exist) ---');
  await runTurn(
    'Use the read tool to read /tmp/definitely-does-not-exist-traceroot-demo.txt ' +
      'and tell me exactly what error occurred.',
    { tools: ['read'] },
  );
}

main()
  .then(() => console.log('\n[Traces exported]'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
