"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiKeyBlock } from "./ApiKeyBlock";

const INSTRUMENT_PROMPT = `I want to add observability to my project using TraceRoot.

Please help me:
1. Install the traceroot Python package (pip install traceroot)
2. Initialize TraceRoot at the entry point of my application:
   import traceroot
   from traceroot import Integration
   traceroot.initialize(integrations=[Integration.OPENAI])  # or Integration.LANGCHAIN
3. Instrument all OpenAI and LangChain calls in my codebase.

The TRACEROOT_API_KEY environment variable is already set in my .env file.`;

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
    </div>
  );
}
