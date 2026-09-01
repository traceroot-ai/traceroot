"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ModelSelector, type ModelSelection } from "./model-selector";

interface MessageInputProps {
  onSend: (message: string, modelSelection: ModelSelection) => void;
  /** Controlled: the owner (chat context) keeps the pick across remounts/reloads. */
  modelSelection: ModelSelection;
  onModelChange: (selection: ModelSelection) => void;
  disabled?: boolean;
  workspaceId?: string;
  actions?: ReactNode;
  /** Overrides the default hint — e.g. while a proposal awaits a decision. */
  placeholder?: string;
}

export function MessageInput({
  onSend,
  modelSelection,
  onModelChange,
  disabled,
  workspaceId,
  actions,
  placeholder,
}: MessageInputProps) {
  const [input, setInput] = useState("");

  const noModelSelected = !modelSelection.model;

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled || noModelSelected) return;
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
        placeholder={placeholder ?? "Ask me about your traces, errors, or performance."}
        disabled={disabled || noModelSelected}
        rows={3}
        className="w-full resize-none rounded-none border border-input bg-transparent px-3 py-2 text-[13px] shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex items-center justify-between">
        <ModelSelector value={modelSelection} onChange={onModelChange} workspaceId={workspaceId} />
        {actions}
      </div>
    </div>
  );
}
