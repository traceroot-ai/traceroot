/**
 * LiveKit Agents — TraceRoot Observability
 *
 * Env vars for real demo: TRACEROOT_API_KEY, LIVEKIT_URL, LIVEKIT_API_KEY,
 * and LIVEKIT_API_SECRET.
 *
 * Run:
 *   npm run demo
 *   npm run console
 *   npm run console:text
 *   npm run dev
 *   npm run start
 */

import "dotenv/config";

import {
  Agent,
  AgentSession,
  ServerOptions,
  cli,
  defineAgent,
  initializeLogger,
  tool,
  type JobContext,
} from "@livekit/agents";
import * as livekitAgents from "@livekit/agents";
import { TraceRoot, usingAttributes } from "@traceroot-ai/traceroot";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// ── LiveKit + TraceRoot setup ────────────────────────────────────────────────

initializeLogger({ pretty: true, level: process.env['LIVEKIT_LOG_LEVEL'] ?? 'info' });

function initializeTraceRoot() {
  TraceRoot.initialize({
    instrumentModules: { livekitAgents },
  });
  console.log("[Observability: TraceRoot + LiveKit]");
}

// ── Tools ─────────────────────────────────────────────────────────────────────

const addNumbers = tool({
  name: "add_numbers",
  description: "Add two numbers and return the sum.",
  parameters: z.object({
    a: z.number().describe("The first number."),
    b: z.number().describe("The second number."),
  }),
  execute: async ({ a, b }) => `${a} + ${b} = ${a + b}`,
});

// ── Agent ─────────────────────────────────────────────────────────────────────

class Assistant extends Agent {
  constructor() {
    super({
      instructions:
        "You are a helpful voice AI assistant. Keep replies short. When the user asks you to add two numbers, call add_numbers before answering.",
      tools: [addNumbers],
    });
  }
}

function newSession({ voice }: { voice: boolean }) {
  if (!voice) {
    return new AgentSession({
      llm: "openai/chat-latest",
      vad: null,
    });
  }

  return new AgentSession({
    stt: "deepgram/nova-3:en",
    llm: "openai/chat-latest",
    tts: "cartesia/sonic-3",
  });
}

// ── Demo ──────────────────────────────────────────────────────────────────────

async function runDemo() {
  initializeTraceRoot();

  const session = newSession({ voice: false });
  try {
    await usingAttributes(
      {
        sessionId: "livekit-ts-demo",
        userId: "demo-user",
        tags: ["demo", "livekit"],
      },
      async () => {
        await session.start({ agent: new Assistant() });

        const result = session.run({
          userInput: "What is 12 plus 30? Use the add_numbers tool.",
        });
        await result.wait();
      },
    );
  } finally {
    await session.close();
    await TraceRoot.shutdown();
  }
}

export default defineAgent({
  entry: async (ctx: JobContext) => {
    initializeTraceRoot();
    ctx.addShutdownCallback(() => TraceRoot.flush());

    const session = newSession({ voice: true });
    await usingAttributes({ sessionId: ctx.room.name }, async () => {
      await session.start({
        agent: new Assistant(),
        room: ctx.room,
      });
      await ctx.connect();
    });
  },
});

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const command = process.argv[2] ?? "demo";
  if (command === "demo") {
    await runDemo();
  } else {
    cli.runApp(
      new ServerOptions({
        agent: fileURLToPath(import.meta.url),
        agentName: "traceroot-livekit-agent",
      }),
    );
  }
}
