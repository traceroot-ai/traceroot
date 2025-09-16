"use client";

import { useControllableState } from "@radix-ui/react-use-controllable-state";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../collapsible";
import { cn } from "@/lib/utils";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { Spinner } from "../spinner";
import type { ComponentProps } from "react";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { extractAnswerContent } from "@/utils/streamingParser";

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = false,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: 0,
    });

    const [hasAutoClosedRef, setHasAutoClosedRef] = useState(false);
    const hasAutoOpenedRef = useRef(false);
    const userCollapsedRef = useRef(false);
    const streamingEndResetTimerRef = useRef<ReturnType<
      typeof setTimeout
    > | null>(null);
    const [startTime, setStartTime] = useState<number | null>(null);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.round((Date.now() - startTime) / 1000));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // Auto-open once when streaming starts, allow manual collapse while streaming
    useEffect(() => {
      if (isStreaming) {
        // If user has manually collapsed, do not auto-open again during this streaming session
        if (!hasAutoOpenedRef.current && !userCollapsedRef.current) {
          setIsOpen(true);
          hasAutoOpenedRef.current = true;
        }
        // Cancel any pending reset timers if streaming resumes
        if (streamingEndResetTimerRef.current) {
          clearTimeout(streamingEndResetTimerRef.current);
          streamingEndResetTimerRef.current = null;
        }
        return;
      }

      // When streaming stops, schedule a reset of auto-open and user-collapsed flags
      // after a short delay to avoid flicker-induced reopen during brief pauses.
      if (!streamingEndResetTimerRef.current) {
        streamingEndResetTimerRef.current = setTimeout(() => {
          hasAutoOpenedRef.current = false;
          userCollapsedRef.current = false;
          streamingEndResetTimerRef.current = null;
        }, AUTO_CLOSE_DELAY);
      }

      // Auto-close once after streaming ends if it remains open
      if (isOpen && !defaultOpen && !hasAutoClosedRef) {
        const timer = setTimeout(() => {
          setIsOpen(false);
          setHasAutoClosedRef(true);
        }, AUTO_CLOSE_DELAY);
        return () => clearTimeout(timer);
      }
    }, [isStreaming, isOpen, defaultOpen, setIsOpen, hasAutoClosedRef]);

    const handleOpenChange = (newOpen: boolean) => {
      // Track manual collapse so we don't auto-reopen during the same streaming session
      if (!newOpen && isStreaming) {
        userCollapsedRef.current = true;
      }
      setIsOpen(newOpen);
    };

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose mb-4", className)}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  title?: string;
};

export const ReasoningTrigger = memo(
  ({
    className,
    title = "Reasoning",
    children,
    ...props
  }: ReasoningTriggerProps) => {
    const { isStreaming, isOpen, duration } = useReasoning();

    return (
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-2 text-muted-foreground text-sm",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-4" />
            {isStreaming ? (
              <div className="flex items-center gap-2">
                <p>Thinking</p>
                <Spinner variant="infinite" className="w-4 h-4" />
              </div>
            ) : (
              <p>Thought {duration} seconds</p>
            )}
            <ChevronDownIcon
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => {
    const { isStreaming } = useReasoning();
    const scrollRef = useRef<HTMLDivElement>(null);

    // Use the same extraction logic as ChatReasoning for consistency
    let displayContent = children;
    if (children) {
      try {
        const jsonData = JSON.parse(children);
        // Only show answer if it exists and is not empty
        if (jsonData.answer && jsonData.answer.trim()) {
          displayContent = jsonData.answer;
        }
      } catch {
        // If JSON parsing fails, only try the streaming parser extraction when reasoning is completed
        // This handles incomplete/streaming JSON but only when transitioning from "Thinking" to "Thought"
        if (!isStreaming) {
          displayContent = extractAnswerContent(children);
        }
      }
    }

    // Auto-scroll to bottom when content changes during streaming
    useEffect(() => {
      if (isStreaming && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [displayContent, isStreaming]);

    // Don't render anything if content is empty
    if (!displayContent || displayContent.trim() === "") {
      return null;
    }

    return (
      <CollapsibleContent
        className={cn(
          "mt-4 ml-4 mr-4 text-xs",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          className,
        )}
        {...props}
      >
        {/* Force text wrapping to prevent horizontal scrolling on long words/content */}
        <div
          ref={scrollRef}
          className={cn(
            "bg-zinc-100 dark:bg-zinc-950 p-4 rounded-md text-zinc-600 dark:text-zinc-400 grid gap-2 whitespace-pre-wrap break-words",
            isStreaming ? "overflow-y-auto h-32" : "overflow-hidden",
          )}
          style={{
            wordBreak: "break-all",
            overflowWrap: "anywhere",
            scrollBehavior: "smooth",
          }}
        >
          {displayContent}
        </div>
      </CollapsibleContent>
    );
  },
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
