import React, { useRef, useEffect } from "react";
import { Send } from "lucide-react";
import { CiChat2 } from "react-icons/ci";
import { GiBrain } from "react-icons/gi";
import { RiRobot2Line } from "react-icons/ri";
import { MdCloudQueue } from "react-icons/md";
import {
  Navbar13,
  type Navbar13Option,
} from "@/components/ui/shadcn-io/navbar-13";
import {
  CHAT_MODEL_DISPLAY_NAMES,
  type ChatModel,
  PROVIDERS,
  PROVIDER_DISPLAY_NAMES,
  type Provider,
  DEFAULT_PROVIDER,
  getModelsByProvider,
  getDefaultModelForProvider,
} from "../../../constants/model";
import { Badge } from "../../ui/badge";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  type PromptInputStatus,
} from "../../ui/prompt-input";
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const status: PromptInputStatus = isLoading ? "streaming" : "ready";
  const hasTraceOrSpans = !!(traceId || (spanIds && spanIds.length > 0));

  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

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
  const getModelDescription = (model: ChatModel): string => {
    switch (model) {
      case "gpt-5":
        return "Best performance but slow";
      case "gpt-4o":
        return "Fast with reasonable performance";
      case "gpt-4.1":
        return "Better performance than GPT-4o";
      case "auto":
        return "Balance performance and cost";
      case "openai/gpt-oss-120b":
        return "Best open source reasoning model";
      default:
        return "";
    }
  };

  const modelOptions: Navbar13Option<ChatModel>[] = availableModels.map(
    (model) => ({
      value: model,
      name: CHAT_MODEL_DISPLAY_NAMES[model],
      description: getModelDescription(model),
      icon: GiBrain,
    }),
  );

  return (
    <div className="border border-zinc-300 rounded-lg dark:border-zinc-700 bg-white dark:bg-zinc-800 mx-4 mb-2">
      <div className="p-3">
        <div className="mb-1 text-xs text-gray-500 dark:text-gray-400 pb-2 flex gap-2 items-center">
          {traceId && (
            <Badge variant="outline" className="font-mono">
              Trace: {traceId}
            </Badge>
          )}
          {spanIds && spanIds.length > 0 && (
            <Badge variant="outline" className="font-mono">
              Spans: {spanIds.length}
            </Badge>
          )}
          {!traceId && (!spanIds || spanIds.length === 0) && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono ml-0">
              No trace or spans selected
            </span>
          )}
        </div>
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
                : hasTraceOrSpans
                  ? "Type your message..."
                  : "Select a trace to start chatting"
            }
            disabled={isLoading || !hasTraceOrSpans}
            minRows={1}
            maxRows={5}
            className="rounded-md border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-1 focus:ring-neutral-500 focus:border-neutral-500 transition-all duration-200"
          />
          <PromptInputToolbar className="border-t-0 pt-1 pb-0 px-0">
            <PromptInputTools>
              {/* Mode selector */}
              <Navbar13
                options={modeOptions}
                selectedValue={selectedMode}
                onValueChange={setSelectedMode}
                label=""
              />

              {/* Provider selector */}
              {setSelectedProvider && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <PromptInputButton variant="outline">
                      <MdCloudQueue className="w-4 h-4" />
                      <span className="text-xs">
                        {PROVIDER_DISPLAY_NAMES[selectedProvider]}
                      </span>
                    </PromptInputButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start">
                    <DropdownMenuRadioGroup
                      value={selectedProvider}
                      onValueChange={handleProviderSelect}
                    >
                      {Object.entries(PROVIDERS).map(([, value]) => (
                        <DropdownMenuRadioItem key={value} value={value}>
                          {PROVIDER_DISPLAY_NAMES[value]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              {/* Model selector */}
              <Navbar13
                options={modelOptions}
                selectedValue={selectedModel}
                onValueChange={setSelectedModel}
                label=""
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
