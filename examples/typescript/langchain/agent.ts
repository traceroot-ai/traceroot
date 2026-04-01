/**
 * LangGraph Code Agent — TraceRoot Observability
 *
 * A LangGraph-powered agent that plans, writes, and executes Python code
 * to answer user queries. Instrumented with TraceRoot via TraceRoot.initialize().
 *
 * langchain: patches the LangChain callback manager to trace all chain/node/LLM spans.
 *
 * Graph: START → plan → code → execute → [retry? → code] → summarize → END
 *
 * Env vars required: OPENAI_API_KEY, TRACEROOT_API_KEY
 *
 * Run:
 *   pnpm demo
 */

import 'dotenv/config';
import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import * as lcCallbackManager from '@langchain/core/callbacks/manager';
import { TraceRoot, observe } from '@traceroot/sdk';

// ── TraceRoot setup ───────────────────────────────────────────────────────────
// langchain: patches the LangChain callback manager to trace chain/node/LLM spans.
// Do NOT pass openAI here — LangChain instrumentation already captures LLM spans;
// adding the raw OpenAI instrumentation creates duplicate spans.
TraceRoot.initialize({
  instrumentModules: { langchain: lcCallbackManager },
});
console.log('[Observability: TraceRoot]');

// ── LLM ───────────────────────────────────────────────────────────────────────
const llm = new ChatOpenAI({ model: 'gpt-4o-mini', temperature: 0 });

// ── Python code execution ─────────────────────────────────────────────────────
const execAsync = promisify(exec);

async function runPythonCode(code: string): Promise<string> {
  const tmpFile = join(tmpdir(), `agent_code_${Date.now()}.py`);
  try {
    writeFileSync(tmpFile, code, 'utf8');
    const { stdout, stderr } = await execAsync(`python3 "${tmpFile}"`, { timeout: 30_000 });
    if (stderr.trim()) return `ERROR: ${stderr.trim()}`;
    return stdout.trim() || '(no output)';
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return `ERROR: ${err.stderr?.trim() ?? err.message ?? String(e)}`;
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

// ── LangGraph state ───────────────────────────────────────────────────────────
const AgentState = Annotation.Root({
  query: Annotation<string>({ reducer: (_, v) => v, default: () => '' }),
  plan: Annotation<string>({ reducer: (_, v) => v, default: () => '' }),
  code: Annotation<string>({ reducer: (_, v) => v, default: () => '' }),
  executionResult: Annotation<string>({ reducer: (_, v) => v, default: () => '' }),
  errorSummary: Annotation<string>({ reducer: (_, v) => v, default: () => '' }),
  summary: Annotation<string>({ reducer: (_, v) => v, default: () => '' }),
  retries: Annotation<number>({ reducer: (_, v) => v, default: () => 0 }),
});
type State = typeof AgentState.State;

// ── Graph nodes ───────────────────────────────────────────────────────────────
async function planNode(state: State): Promise<Partial<State>> {
  const retryCtx = state.errorSummary
    ? `\nPrevious attempt failed: ${state.errorSummary}\nPlease adjust the approach.`
    : '';
  const response = await llm.invoke([
    new SystemMessage(
      'You are a code planning assistant. Given a user query, produce a concise step-by-step plan for Python code that solves it.',
    ),
    new HumanMessage(`Query: ${state.query}${retryCtx}`),
  ]);
  const plan = response.content as string;
  console.log('\n[Plan]\n' + plan);
  return { plan };
}

async function codeNode(state: State): Promise<Partial<State>> {
  const retryCtx = state.errorSummary
    ? `\nPrevious code failed with: ${state.errorSummary}\nPlease fix the issues.`
    : '';
  const response = await llm.invoke([
    new SystemMessage(
      'You are a Python code generator. Generate clean, executable Python code based on the plan. ' +
        'Output ONLY raw Python code — no markdown fences, no explanations.',
    ),
    new HumanMessage(`Plan:\n${state.plan}\n\nQuery: ${state.query}${retryCtx}`),
  ]);
  let code = response.content as string;
  code = code
    .replace(/^```(?:python)?\n?/m, '')
    .replace(/```\s*$/m, '')
    .trim();
  console.log('\n[Code]\n' + code);
  return { code };
}

async function executeNode(state: State): Promise<Partial<State>> {
  console.log('\n[Executing Python code...]');
  const executionResult = await runPythonCode(state.code);
  const preview = executionResult.slice(0, 300) + (executionResult.length > 300 ? '...' : '');
  console.log('[Result] ' + preview);
  if (executionResult.startsWith('ERROR:')) {
    return { executionResult, errorSummary: executionResult, retries: state.retries + 1 };
  }
  return { executionResult, errorSummary: '' };
}

async function summarizeNode(state: State): Promise<Partial<State>> {
  const response = await llm.invoke([
    new SystemMessage(
      "You are a helpful assistant. Summarize the answer to the user's query based on the Python code and its execution results.",
    ),
    new HumanMessage(
      `Query: ${state.query}\n\nCode:\n${state.code}\n\nExecution Result:\n${state.executionResult}`,
    ),
  ]);
  return { summary: response.content as string };
}

function shouldRetry(state: State): 'code' | 'summarize' {
  if (state.executionResult.startsWith('ERROR:') && state.retries <= 2) {
    console.log(`\n[Retrying... attempt ${state.retries}/2]`);
    return 'code';
  }
  return 'summarize';
}

// ── Build graph ───────────────────────────────────────────────────────────────
const app = new StateGraph(AgentState)
  .addNode('planner', planNode)
  .addNode('coder', codeNode)
  .addNode('executor', executeNode)
  .addNode('summarizer', summarizeNode)
  .addEdge(START, 'planner')
  .addEdge('planner', 'coder')
  .addEdge('coder', 'executor')
  .addConditionalEdges('executor', shouldRetry, { code: 'coder', summarize: 'summarizer' })
  .addEdge('summarizer', END)
  .compile();

// ── Run agent ─────────────────────────────────────────────────────────────────
async function runAgent(query: string): Promise<string> {
  return observe({ name: 'langchain_agent', type: 'agent' }, async () => {
    const result = await app.invoke({ query, retries: 0 });
    return result.summary;
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────
const DEMO_QUERIES = [
  'Calculate the first 20 Fibonacci numbers and print them.',
  'Find all prime numbers up to 100 using the Sieve of Eratosthenes and print the list.',
  'Compute 15! (factorial of 15) and express it in scientific notation.',
];

async function main() {
  try {
    await observe({ name: 'demo_session' }, async () => {
      console.log('='.repeat(60));
      console.log('LangGraph Code Agent — Demo (TraceRoot)');
      console.log('='.repeat(60));

      for (let i = 0; i < DEMO_QUERIES.length; i++) {
        const query = DEMO_QUERIES[i];
        console.log(`\n${'='.repeat(60)}`);
        console.log(`Query ${i + 1}: ${query}`);
        console.log('='.repeat(60));
        const summary = await runAgent(query);
        console.log('\nAgent: ' + summary);
        console.log();
      }
    });
  } finally {
    await TraceRoot.shutdown();
    console.log('[Traces exported]');
  }
}

main().catch(console.error);
