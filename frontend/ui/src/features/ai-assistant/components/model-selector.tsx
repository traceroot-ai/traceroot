"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const PROVIDERS = [
  {
    id: "anthropic",
    label: "Anthropic",
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    models: [
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
    ],
  },
] as const;

const ALL_MODELS = PROVIDERS.flatMap((p) => p.models);

interface ModelSelectorProps {
  value: string;
  onChange: (model: string) => void;
}

export function ModelSelector({ value, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const selectedModel = ALL_MODELS.find((m) => m.id === value);

  const provider = selectedProvider ? PROVIDERS.find((p) => p.id === selectedProvider) : null;

  return (
    <div className="flex items-center">
      <Popover
        open={open}
        onOpenChange={(isOpen) => {
          setOpen(isOpen);
          if (!isOpen) setSelectedProvider(null);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 rounded-sm px-2 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {selectedModel?.label || "Select model"}
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-[180px] p-1" sideOffset={4}>
          {!provider
            ? // Page 1: Provider list
              PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className="flex w-full items-center rounded-md px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-muted/50"
                  onClick={() => setSelectedProvider(p.id)}
                >
                  {p.label}
                </button>
              ))
            : // Page 2: Model list for selected provider
              provider.models.map((m) => (
                <button
                  key={m.id}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12px] transition-colors hover:bg-muted/50",
                    m.id === value && "font-medium text-foreground",
                  )}
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                    setSelectedProvider(null);
                  }}
                >
                  {m.id === value && <span className="text-[11px]">✓</span>}
                  {m.label}
                </button>
              ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
