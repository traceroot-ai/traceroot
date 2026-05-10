import "dotenv/config";
import OpenAI from "openai";
import { TraceRoot, observe, usingAttributes } from "@traceroot-ai/traceroot";

TraceRoot.initialize({
  instrumentModules: { openAI: OpenAI },
});

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-3-5-sonnet";

async function runChat(): Promise<string> {
  return observe({ name: "openrouter_chat", type: "llm" }, async () => {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "You are a concise assistant explaining observability concepts." },
        { role: "user", content: "Explain why tracing is useful for AI agents in two sentences." },
      ],
    });

    return response.choices[0].message.content ?? "";
  });
}

async function main() {
  try {
    await usingAttributes(
      {
        sessionId: "openrouter-typescript-demo",
        userId: "openrouter-example-user",
        tags: ["demo", "openrouter", "openai-compatible"],
      },
      async () => {
        console.log(await runChat());
      },
    );
  } finally {
    await TraceRoot.shutdown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});