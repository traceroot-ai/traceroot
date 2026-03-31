"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ApiKeyBlock } from "./ApiKeyBlock";

const INSTRUMENT_PROMPT = `I want to add observability to my project using Traceroot.

Please help me:
1. Install the traceroot Python package (pip install traceroot)
2. Initialize Traceroot at the entry point of my application:
   import traceroot
   traceroot.init()
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
    <Button
      variant="outline"
      size="sm"
      className="ml-4 h-7 shrink-0 text-[11px]"
      onClick={handleCopy}
    >
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

interface AiTabProps {
  projectId: string;
}

export function AiTab({ projectId }: AiTabProps) {
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
            <p className="text-sm font-medium text-foreground">
              Install and instrument from scratch
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Best for new projects or repos without existing observability.
            </p>
          </div>
          <CopyPromptButton value={INSTRUMENT_PROMPT} />
        </div>
      </div>
    </div>
  );
}
