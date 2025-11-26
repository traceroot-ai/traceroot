import React, { useRef, useEffect } from "react";
import { Send } from "lucide-react";
import { CiChat2 } from "react-icons/ci";
import { GiBrain } from "react-icons/gi";
import { RiRobot2Line } from "react-icons/ri";
import {
  Navbar13,
  type Navbar13Option,
} from "@/components/ui/shadcn-io/navbar-13";
import {
  CHAT_MODEL_DISPLAY_NAMES,
  type ChatModel,
  type Provider,
  DEFAULT_PROVIDER,
  getModelsByProvider,
} from "../../../constants/model";
import { Badge } from "../../ui/badge";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputStatus,
} from "../../ui/prompt-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip";

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
  traceId?: string;
  traceIds?: string[];
  spanIds?: string[];
}

// Helper function to get model description
const getModelDescription = (model: ChatModel): string => {
  switch (model) {
    case "gpt-5":
      return "Best performance but slower";
    case "gpt-4o":
      return "Fast with good performance";
    case "gpt-4.1":
      return "Better than GPT-4o";
    case "auto":
      return "Balance performance and cost";
    default:
      return "";
  }
};

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
  traceId,
  traceIds = [],
  spanIds = [],
}: MessageInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const status: PromptInputStatus = isLoading ? "streaming" : "ready";
  const hasMultipleTraces = traceIds.length > 1;
  const hasTraceOrSpans = !!(
    traceId ||
    traceIds.length > 0 ||
    (spanIds && spanIds.length > 0)
  );

  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  // Get available models for current provider
  const availableModels = getModelsByProvider(selectedProvider);

  // Define mode options for Navbar13
  const modeOptions: Navbar13Option<Mode>[] = [
    {
      value: "agent",
      name: "Agent",
      description: "Advanced functionalities such as GitHub",
      icon: RiRobot2Line,
    },
    {
      value: "chat",
      name: "Chat",
      description: "Fast summarization and root cause analysis",
      icon: CiChat2,
    },
  ];

  // Define model options for Navbar13
  const modelOptions: Navbar13Option<ChatModel>[] = availableModels.map(
    (model) => ({
      value: model,
      name: CHAT_MODEL_DISPLAY_NAMES[model],
      description: getModelDescription(model),
      icon: GiBrain,
    }),
  );

  return (
    <div className="bg-white dark:bg-zinc-900 border-t border-neutral-300 dark:border-neutral-700 flex-shrink-0">
      {/* Header with trace info - similar to LogDetail/TraceDetail */}
      {(hasTraceOrSpans || hasMultipleTraces) && (
        <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-black">
          <div className="flex items-center gap-2 flex-wrap">
            {hasMultipleTraces ? (
              <Badge variant="secondary" className="h-6 font-mono text-xs">
                {traceIds.length} traces selected
              </Badge>
            ) : traceId ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="default"
                    className="h-6 font-mono text-xs font-normal max-w-[200px] overflow-hidden text-ellipsis cursor-default"
                  >
                    {traceId.substring(0, 8)}...
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="font-mono text-xs">{traceId}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
            {spanIds && spanIds.length > 0 && (
              <Badge variant="outline" className="h-6 font-mono text-xs">
                {spanIds.length} span{spanIds.length > 1 ? "s" : ""}
              </Badge>
            )}
          </div>
        </div>
      )}

      {/* Input area */}
      <div className="p-2">
        <PromptInput
          onSubmit={onSendMessage}
          className="divide-y-0 border-0 bg-transparent shadow-none rounded-none"
        >
          <PromptInputTextarea
            ref={inputRef}
            value={inputMessage}
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!isLoading && inputMessage.trim()) {
                  onSendMessage(e as any);
                }
              }
            }}
            placeholder={
              isLoading
                ? "Agent is thinking..."
                : hasMultipleTraces
                  ? "Agent is disabled when multiple traces are selected"
                  : hasTraceOrSpans
                    ? "Type your message..."
                    : "Select a trace to start chatting"
            }
            disabled={isLoading || !hasTraceOrSpans || hasMultipleTraces}
            minRows={1}
            maxRows={5}
            className="rounded-md border border-zinc-200 dark:border-zinc-700 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-neutral-500 focus:border-neutral-500 transition-all duration-200 text-sm"
          />
          <PromptInputToolbar className="border-t-0 pt-1.5 pb-0 px-0">
            <PromptInputTools className="gap-1.5">
              {/* Mode selector */}
              <Navbar13
                options={modeOptions}
                selectedValue={selectedMode}
                onValueChange={setSelectedMode}
                label="Mode"
              />

              {/* Model selector */}
              <Navbar13
                options={modelOptions}
                selectedValue={selectedModel}
                onValueChange={setSelectedModel}
                label="Model"
              />
            </PromptInputTools>

            <PromptInputSubmit
              status={status}
              disabled={!inputMessage.trim() || !hasTraceOrSpans}
              className="bg-neutral-700 dark:bg-neutral-300 hover:bg-neutral-800 dark:hover:bg-neutral-200 text-white dark:text-neutral-800"
            >
              {!isLoading && <Send className="w-4 h-4" />}
            </PromptInputSubmit>
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </div>
  );
}
