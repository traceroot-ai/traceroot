import React, { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import { CiChat2 } from "react-icons/ci";
import { GiBrain } from "react-icons/gi";
import { RiRobot2Line } from "react-icons/ri";
import { MdCloudQueue } from "react-icons/md";
import {
  CHAT_MODEL_DISPLAY_NAMES,
  CHAT_MODELS,
  type ChatModel,
  PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  type Provider,
  DEFAULT_PROVIDER,
  getModelsByProvider,
  getDefaultModelForProvider,
} from "../../../constants/model";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/shadcn-io/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";

type Mode = "agent" | "chat";

interface MessageInputProps {
  inputMessage: string;
  setInputMessage: (message: string) => void;
  isLoading: boolean;
  onSendMessage: (e: React.FormEvent) => void;
  selectedModel: ChatModel;
  setSelectedModel: (model: ChatModel) => void;
  selectedMode: Mode;
  setSelectedMode: (mode: Mode) => void;
  selectedProvider?: Provider;
  setSelectedProvider?: (provider: Provider) => void;
  traceId?: string;
  spanIds?: string[];
}

export default function MessageInput({
  inputMessage,
  setInputMessage,
  isLoading,
  onSendMessage,
  selectedModel,
  setSelectedModel,
  selectedMode,
  setSelectedMode,
  selectedProvider = DEFAULT_PROVIDER,
  setSelectedProvider,
  traceId,
  spanIds = [],
}: MessageInputProps) {
  const [textareaHeight, setTextareaHeight] = useState("auto");

  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  const adjustTextareaHeight = () => {
    const textarea = inputRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto";

    // Get the computed line height
    const lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight);
    const minHeight = lineHeight; // One line height
    const maxHeight = lineHeight * 5; // Maximum 5 lines

    // Set the height based on content, but clamp between min and max
    const newHeight = Math.min(
      Math.max(textarea.scrollHeight, minHeight),
      maxHeight,
    );
    textarea.style.height = `${newHeight}px`;
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputMessage]);

  const handleModelSelect = (model: string) => {
    setSelectedModel(model as ChatModel);
  };

  const handleProviderSelect = (provider: string) => {
    const newProvider = provider as Provider;
    if (setSelectedProvider) {
      setSelectedProvider(newProvider);
      // When provider changes, switch to the default model for that provider
      const defaultModel = getDefaultModelForProvider(newProvider);
      setSelectedModel(defaultModel);
    }
  };

  // Get available models for current provider
  const availableModels = getModelsByProvider(selectedProvider);

  const handleModeSelect = (mode: string) => {
    setSelectedMode(mode as Mode);
  };

  const getModeIcon = (mode: Mode) => {
    return mode === "agent" ? RiRobot2Line : CiChat2;
  };

  const getModeDisplayName = (mode: Mode) => {
    return mode === "agent" ? "Agent" : "Chat";
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-zinc-800">
      <form onSubmit={onSendMessage} className="p-3">
        <div className="mb-1 text-xs text-gray-500 dark:text-gray-400 pb-1 px-1 flex gap-2 items-center">
          {traceId && (
            <Badge variant="secondary" className="font-mono">
              Trace: {traceId}
            </Badge>
          )}
          {spanIds && spanIds.length > 0 && (
            <Badge variant="secondary" className="font-mono">
              Spans selected: {spanIds.length}
            </Badge>
          )}
          {!traceId && (!spanIds || spanIds.length === 0) && (
            <span>No trace or spans selected</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="relative w-full">
            <textarea
              ref={inputRef}
              value={inputMessage}
              onChange={(e) => {
                setInputMessage(e.target.value);
                adjustTextareaHeight();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!isLoading && inputMessage.trim()) {
                    // Manually trigger form submit
                    onSendMessage(e as any);
                  }
                }
              }}
              placeholder={
                isLoading ? "Agent is thinking..." : "Type your message..."
              }
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-zinc-700 px-4 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:border-neutral-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 resize-none leading-relaxed overflow-y-auto text-sm"
              style={{ height: textareaHeight }}
              disabled={isLoading}
              rows={1}
            />
            {isLoading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <Spinner
                  variant="infinite"
                  className="w-4 h-4 text-neutral-500"
                />
              </div>
            )}
          </div>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              {/* Mode selector */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 bg-zinc-50 dark:bg-zinc-900"
                  >
                    {React.createElement(getModeIcon(selectedMode), {
                      className: "w-4 h-4",
                    })}
                    <span className="text-xs">
                      {getModeDisplayName(selectedMode)}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start">
                  <DropdownMenuRadioGroup
                    value={selectedMode}
                    onValueChange={handleModeSelect}
                  >
                    <DropdownMenuRadioItem value="agent">
                      <RiRobot2Line className="w-4 h-4" />
                      Agent
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="chat">
                      <CiChat2 className="w-4 h-4" />
                      Chat
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Provider selector */}
              {setSelectedProvider && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2 bg-zinc-50 dark:bg-zinc-900"
                    >
                      <MdCloudQueue className="w-4 h-4" />
                      <span className="text-xs">
                        {PROVIDER_DISPLAY_NAMES[selectedProvider]}
                      </span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    <DropdownMenuRadioGroup
                      value={selectedProvider}
                      onValueChange={handleProviderSelect}
                    >
                      {Object.entries(PROVIDERS).map(([key, value]) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          {PROVIDER_DISPLAY_NAMES[value]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* Brain icon and model display */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-2 bg-zinc-50 dark:bg-zinc-900"
                  >
                    <GiBrain className="w-4 h-4" />
                    <span className="text-xs">
                      {CHAT_MODEL_DISPLAY_NAMES[selectedModel]}
                    </span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start">
                  <DropdownMenuRadioGroup
                    value={selectedModel}
                    onValueChange={handleModelSelect}
                  >
                    {availableModels.map((model) => (
                      <DropdownMenuRadioItem key={model} value={model}>
                        {CHAT_MODEL_DISPLAY_NAMES[model]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <Button
              type="submit"
              size="icon"
              className="w-8 h-8 bg-neutral-700 dark:bg-neutral-300 hover:bg-neutral-800 dark:hover:bg-neutral-200 text-white dark:text-neutral-800"
              disabled={!inputMessage.trim() || isLoading}
            >
              {isLoading ? (
                <Spinner variant="infinite" className="w-4 h-4 text-white" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
