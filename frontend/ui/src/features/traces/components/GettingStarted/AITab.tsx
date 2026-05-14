"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { GitHubConnectButton } from "@/components/github/GitHubConnectButton";
import { ApiKeyBlock } from "./ApiKeyBlock";

const INSTRUMENT_PROMPT = `I want to add observability to my project using TraceRoot.

My project uses [Python / TypeScript/Node.js] — adjust the instructions to match my stack.

**Python setup:**
1. Install: pip install traceroot
2. Initialize at the entry point, before any LLM imports:
   from dotenv import load_dotenv
   load_dotenv()
   import traceroot
   from traceroot import Integration
   traceroot.initialize(integrations=[
       Integration.OPENAI,        # if using OpenAI
       Integration.LANGCHAIN,     # if using LangChain/LangGraph/DeepAgents
       Integration.ANTHROPIC,     # if using Anthropic
       Integration.GOOGLE_GENAI,  # if using Google Gemini
       Integration.MISTRAL,       # if using Mistral
       Integration.CREWAI,        # if using CrewAI
       Integration.AUTOGEN,       # if using AutoGen (AG2)
       Integration.LLAMA_INDEX,   # if using LlamaIndex
       Integration.AGNO,          # if using Agno
       Integration.DSPY,          # if using DSPy
       Integration.GOOGLE_ADK,    # if using Google ADK
   ])
3. Add @observe on agent entrypoints and tool functions:
   from traceroot import observe
   @observe(name="my_agent", type="agent")
   def run(query): ...
4. Wrap request handlers with using_attributes to attach user/session context:
   from traceroot import using_attributes
   with using_attributes(user_id="u-123", session_id="s-456"):
       result = run(query)
5. Call traceroot.flush() at the end of short-lived scripts.

**TypeScript/Node.js setup:**
1. Install: npm install @traceroot-ai/traceroot
2. Initialize at the entry point, before any LLM imports:
   import { TraceRoot } from '@traceroot-ai/traceroot';
   import OpenAI from 'openai';
   import Anthropic from '@anthropic-ai/sdk';
   import * as lcCallbackManager from '@langchain/core/callbacks/manager';
   TraceRoot.initialize({
     instrumentModules: {
       openAI: OpenAI,                    // if using OpenAI
       anthropic: Anthropic,              // if using Anthropic
       langchain: lcCallbackManager,      // if using LangChain/LangGraph/DeepAgents
     },
   });

   For Mastra, use the dedicated exporter instead:
   npm install @traceroot-ai/mastra
   import { TraceRootExporter } from '@traceroot-ai/mastra';
   const exporter = new TraceRootExporter({ apiKey: process.env.TRACEROOT_API_KEY });
   // Pass exporter to Mastra's Observability config (see docs/integrations/mastra)

   For the Vercel AI SDK, no instrumentModules entry is needed:
   TraceRoot.initialize();
   // Then on each generateText / streamText / generateObject call, set:
   //   experimental_telemetry: { isEnabled: true }
   // (See docs/integrations/vercel-ai)
3. Wrap agent entrypoints and tool functions with observe():
   import { observe } from '@traceroot-ai/traceroot';
   const result = await observe({ name: 'my_agent', type: 'agent' }, async () => {
     return await runPipeline(query);
   });
4. Wrap request handlers with usingAttributes to attach user/session context:
   import { usingAttributes } from '@traceroot-ai/traceroot';
   const result = await usingAttributes(
     { userId: 'u-123', sessionId: 's-456' },
     async () => await runAgent(query),
   );
5. Call await TraceRoot.flush() at the end of short-lived scripts.

The TRACEROOT_API_KEY environment variable is already set in my .env file.`;

const SKILLS = [
  {
    name: "Send your first trace",
    description:
      "Verify your API key and SDK are wired up correctly with a minimal working example.",
    command: "npx skills add traceroot-ai/traceroot-skills --skill traceroot-quickstart",
  },
  {
    name: "Instrument your project",
    description: "Automatically add TraceRoot tracing to your LLM calls, agents, and tools.",
    command: "npx skills add traceroot-ai/traceroot-skills --skill traceroot-instrument-repo",
  },
];

function CopyPromptButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable (insecure context or permission denied)
    }
  };

  return (
    <Button variant="outline" size="sm" className="ml-4 h-7 shrink-0 text-xs" onClick={handleCopy}>
      {copied ? (
        <>
          <Check className="mr-1 h-3 w-3 text-green-600" />
          copied!
        </>
      ) : (
        "copy prompt"
      )}
    </Button>
  );
}

interface AITabProps {
  projectId: string;
}

export function AITab({ projectId }: AITabProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">1. Create an API key</p>
        <ApiKeyBlock projectId={projectId} />
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          2. Paste a prompt to instrument your code
        </p>
        <div className="flex items-start justify-between rounded-sm border border-border bg-muted/30 px-4 py-3">
          <div>
            <p className="text-sm font-medium text-foreground">Auto-instrument your codebase</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Paste this prompt into your AI coding assistant to add tracing automatically.
            </p>
          </div>
          <CopyPromptButton value={INSTRUMENT_PROMPT} />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">3. Or install and run a skill</p>
        <div className="space-y-2">
          {SKILLS.map((skill) => (
            <div key={skill.name} className="rounded-sm border border-border bg-muted/30 px-4 py-3">
              <p className="text-xs font-medium text-primary">{skill.name}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{skill.description}</p>
              <div className="mt-2 flex items-center justify-between border border-border bg-muted px-3 py-2">
                <span className="font-mono text-xs text-foreground">{skill.command}</span>
                <CopyButton value={skill.command} className="ml-3 h-6 w-6 shrink-0" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">
          4. Optionally connect your GitHub repositories
        </p>
        <div className="rounded-sm border border-border bg-muted/30 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Install the GitHub App for repository linking and code-level tracing during root cause
            analysis.
          </p>
          <div className="mt-3">
            <GitHubConnectButton />
          </div>
        </div>
      </div>
    </div>
  );
}
