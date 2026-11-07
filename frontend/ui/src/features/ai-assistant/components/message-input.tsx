"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ModelSelector, type ModelSelection } from "./model-selector";

interface MessageInputProps {
  /**
   * Sends the message. Resolving `false` means the send was refused (a parked
   * proposal is mid-decision) and the composer restores what it cleared.
   */
  onSend: (message: string, modelSelection: ModelSelection) => void | Promise<boolean | void>;
  /** Controlled: the owner (chat context) keeps the pick across remounts/reloads. */
  modelSelection: ModelSelection;
  onModelChange: (selection: ModelSelection) => void;
  disabled?: boolean;
  /** Let users compose, but explain why sending is unavailable. */
  blockedReason?: string;
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
  blockedReason,
  workspaceId,
  actions,
  placeholder,
}: MessageInputProps) {
  const [sendBlocked, setSendBlocked] = useState(false);
  const [input, setInput] = useState("");

  const noModelSelected = !modelSelection.model && !blockedReason;

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || disabled || noModelSelected) return;
    if (blockedReason) {
      setSendBlocked(true);
      return;
    }
    setInput("");
    // Clear optimistically so the composer stays responsive, then put the text
    // back if the send was refused — a dropped message with no bubble and no
    // error reads as the product losing what someone typed.
    void Promise.resolve(onSend(trimmed, modelSelection))
      .then((accepted) => {
        if (accepted === false) setInput((current) => (current === "" ? trimmed : current));
      })
      // A send that rejects has already surfaced its own failure; swallowing it
      // here keeps a failed send from becoming an unhandled rejection.
      .catch(() => {});
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
      {sendBlocked && blockedReason && (
        <p role="alert" className="mb-2 text-[12px] text-destructive">
          {blockedReason}
        </p>
      )}
      <div className="flex items-center justify-between">
        <ModelSelector value={modelSelection} onChange={onModelChange} workspaceId={workspaceId} />
        {actions}
      </div>
    </div>
  );
}
