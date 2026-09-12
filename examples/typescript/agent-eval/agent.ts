/**
 * Tool-using research agent (Vercel AI SDK) — the system under evaluation.
 *
 * Exposes `runAgent`, which answers a question by calling tools over FIXED data, so
 * every question has an exact ground-truth answer (NVDA is 495.20, a 10% rise 544.72).
 */

import { generateText, tool, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

// Fixed prices — the ground truth the dataset is written against.
const STOCKS: Record<
  string,
  { price: number; change: number; percent: string }
> = {
  AAPL: { price: 178.5, change: 2.3, percent: "+1.3%" },
  GOOGL: { price: 141.2, change: -0.8, percent: "-0.6%" },
  MSFT: { price: 378.9, change: 4.5, percent: "+1.2%" },
  NVDA: { price: 495.2, change: 12.3, percent: "+2.5%" },
  META: { price: 512.4, change: 8.1, percent: "+1.6%" },
};

// Arithmetic on numbers with + - * / and parentheses, parsed by hand so the
// model's input never reaches eval() or Function(). Throws on anything else.
function evaluate(expression: string): number {
  const tokens = expression.match(/\d+(?:\.\d+)?|[+\-*/()]/g) ?? [];
  if (tokens.join("") !== expression.replace(/\s+/g, ""))
    throw new Error("unsupported input");
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = (): number => {
    const t = next();
    if (t === "(") {
      const v = expr();
      if (next() !== ")") throw new Error("expected )");
      return v;
    }
    if (t === "-") return -primary();
    if (t === undefined || !/^\d/.test(t)) throw new Error("expected number");
    return Number(t);
  };
  const term = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/")
      v = next() === "*" ? v * primary() : v / primary();
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === "+" || peek() === "-")
      v = next() === "+" ? v + term() : v - term();
    return v;
  };
  const value = expr();
  if (i !== tokens.length) throw new Error("trailing input");
  return value;
}

const SYSTEM_PROMPT =
  "You are a financial research assistant. Use the available tools to look up " +
  "stock prices and to perform any arithmetic. Never compute prices or do math " +
  "from memory — always call the calculate tool. Report concrete numbers and keep " +
  "your answer concise.";

export interface AgentResult {
  answer: string;
  toolsUsed: string[];
  steps: number;
}

export async function runAgent(input: {
  question: string;
}): Promise<AgentResult> {
  const result = await generateText({
    // openai.chat → Chat Completions API (matches the sibling tracing examples).
    model: openai.chat("gpt-4o-mini"),
    // temperature 0 → the same question yields the same tool calls and answer.
    temperature: 0,
    // Emit OpenTelemetry model/tool spans so TraceRoot captures the agent's
    // execution (matches the sibling `examples/typescript/vercel-ai` example).
    experimental_telemetry: { isEnabled: true },
    stopWhen: stepCountIs(5),
    system: SYSTEM_PROMPT,
    prompt: input.question,
    tools: {
      getStockPrice: tool({
        description: "Get the current stock price for a ticker symbol",
        inputSchema: z.object({
          symbol: z.string().describe("Stock ticker symbol e.g. NVDA"),
        }),
        execute: async ({ symbol }) => {
          const upper = symbol.toUpperCase();
          const data = STOCKS[upper] ?? { price: 0, change: 0, percent: "N/A" };
          return { symbol: upper, ...data };
        },
      }),
      calculate: tool({
        description: "Evaluate a mathematical expression",
        inputSchema: z.object({
          expression: z
            .string()
            .describe("Math expression e.g. '495.20 * 1.1'"),
        }),
        execute: async ({ expression }) => {
          try {
            return { expression, result: evaluate(expression) };
          } catch {
            return { error: `Invalid expression: ${expression}` };
          }
        },
      }),
    },
  });

  // Collect the tools called across every step, de-duplicated in call order.
  const toolsUsed: string[] = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      if (!toolsUsed.includes(call.toolName)) {
        toolsUsed.push(call.toolName);
      }
    }
  }

  return { answer: result.text, toolsUsed, steps: result.steps.length };
}

// ---------------------------------------------------------------------------
// Standalone entrypoint — `pnpm agent`
// ---------------------------------------------------------------------------
// Runs the agent on a sample question and prints the structured result. Guarded
// so importing this module (as `main.ts` does) never triggers a run — only
// executing the file directly does.
if (require.main === module) {
  // Load OPENAI_API_KEY (and friends) from .env for the standalone run.
  require("dotenv/config");
  runAgent({ question: "What is the current stock price of NVDA?" })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
