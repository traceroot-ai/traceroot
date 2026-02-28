"use client";

import { useState, type KeyboardEvent } from "react";
import { ModelSelector, type ModelSelection } from "./model-selector";

interface MessageInputProps {
  onSend: (message: string, modelSelection: ModelSelection) => void;
  disabled?: boolean;
  workspaceId?: string;
}

export function MessageInput({ onSend, disabled, workspaceId }: MessageInputProps) {
  const [input, setInput] = useState("");
  const [modelSelection, setModelSelection] = useState<ModelSelection>({
    model: "claude-sonnet-4-5",
    provider: "Anthropic",
    source: "system",
  });

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed, modelSelection);
    setInput("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="px-3 py-2">
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask me about your traces, errors, or performance."
        disabled={disabled}
        rows={3}
        className="w-full resize-none rounded-none border border-input bg-transparent px-3 py-2 text-[13px] shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <ModelSelector
        value={modelSelection}
        onChange={setModelSelection}
        workspaceId={workspaceId}
      />
    </div>
  );
}
