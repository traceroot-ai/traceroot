"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AIMessage, ToolCallStep } from "../types";

// ---------------------------------------------------------------------------
// Markdown renderer config — only override what prose can't handle
// ---------------------------------------------------------------------------
const markdownComponents: Components = {
  // Custom block/inline detection — prose styles pre/code but can't detect
  // unlabelled fences (no language-* class) without this heuristic
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes("language-") || String(children).includes("\n");
    return isBlock ? (
      <code className="block overflow-x-auto" {...props}>
        {children}
      </code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" {...props}>
        {children}
      </code>
    );
  },
  // Open links in new tab
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
};

// ---------------------------------------------------------------------------
// AnimatedItem — grows from 0 height on mount so new items slide in smoothly
// ---------------------------------------------------------------------------
function AnimatedItem({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);

  useLayoutEffect(() => {
    // Wait one paint so the browser records the start state (height 0) before transitioning
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
        visible ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="overflow-hidden">
        <div className="pb-2">{children}</div>
      </div>
    </div>
  );
}

function formatToolName(name: string): string {
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function ToolStepItem({ step, isActive }: { step: ToolCallStep; isActive: boolean }) {
  const [isOpen, setIsOpen] = useState(isActive);

  useEffect(() => {
    if (isActive) {
      setIsOpen(true);
    } else {
      // Delay collapse so the new item finishes sliding in first (matches AnimatedItem duration)
      const t = setTimeout(() => setIsOpen(false), 200);
      return () => clearTimeout(t);
    }
  }, [isActive]);

  const argsStr = JSON.stringify(step.args, null, 2);
  const resultStr = step.result != null ? JSON.stringify(step.result, null, 2) : null;

  return (
    <div className="text-[11px]">
      <button
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full cursor-pointer select-none items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted/50"
      >
        {step.status === "running" && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
        )}
        {step.status === "done" && <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500/70" />}
        {step.status === "error" && <XCircle className="h-3 w-3 shrink-0 text-destructive/70" />}
        <span className="italic text-muted-foreground/80">{formatToolName(step.toolName)}</span>
        <span className="font-mono text-[10px] text-muted-foreground/40">({step.toolName})</span>
        <ChevronRight
          className={cn(
            "ml-auto h-3 w-3 shrink-0 text-muted-foreground/30 transition-transform duration-200",
            isOpen && "rotate-90",
          )}
        />
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-in-out",
          isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          <div className="mt-1 space-y-1.5 pl-5">
            <div>
              <p className="mb-0.5 text-muted-foreground/50">Args</p>
              <pre className="overflow-x-auto rounded bg-background/70 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground/60">
                {argsStr}
              </pre>
            </div>
            {resultStr && (
              <div>
                <p
                  className={cn(
                    "mb-0.5",
                    step.isError ? "text-destructive/70" : "text-muted-foreground/50",
                  )}
                >
                  {step.isError ? "Error" : "Result"}
                </p>
                <pre className="max-h-[200px] overflow-auto rounded bg-background/70 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-foreground/60">
                  {resultStr}
                </pre>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function AssistantBubble({ msg }: { msg: AIMessage }) {
  return (
    <div className="break-words rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground">
      {msg.thinking && (
        <details className="group mb-2 text-[11px]">
          <summary className="flex cursor-pointer select-none list-none items-center gap-1.5 text-muted-foreground/60 hover:text-muted-foreground">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            <span className="italic">Reasoning</span>
          </summary>
          <pre className="mt-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap border-l-2 border-muted-foreground/20 pl-3 font-mono text-[10px] leading-relaxed text-muted-foreground/60">
            {msg.thinking}
          </pre>
        </details>
      )}
      <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert [&_*]:text-xs">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          // Ensure headings that immediately follow text (no blank line) are
          // still parsed as headings. LLMs often omit the preceding newline.
          children={msg.content.replace(/(^|[^\n])(#{1,6} )/g, "$1\n\n$2")}
          components={markdownComponents}
        />
      </div>
      {msg.isStreaming && (
        <span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-current" />
      )}
    </div>
  );
}

function UserBubble({ msg }: { msg: AIMessage }) {
  return (
    <div className="whitespace-pre-wrap break-words rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground">
      {msg.content}
    </div>
  );
}

function UsageFooter({ msg }: { msg: AIMessage }) {
  return (
    <div className="mt-1 flex items-center gap-2 px-1 text-[10px] text-muted-foreground/60">
      <span title="Input tokens">{msg.inputTokens!.toLocaleString()} in</span>
      <span>·</span>
      <span title="Output tokens">{msg.outputTokens!.toLocaleString()} out</span>
      {msg.totalTokens != null && (
        <>
          <span>·</span>
          <span title="Cumulative session tokens">{msg.totalTokens.toLocaleString()} session</span>
        </>
      )}
      {msg.costUsd != null && msg.costUsd > 0 && (
        <>
          <span>·</span>
          <span title="Estimated cost">${msg.costUsd.toFixed(4)}</span>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageList
// ---------------------------------------------------------------------------
interface MessageListProps {
  messages: AIMessage[];
  sessionStreaming?: boolean;
}

export function MessageList({ messages, sessionStreaming = false }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const isStreaming = messages.some((m) => m.isStreaming);
  // True when the session is active but no text bubble is open — the LLM is processing
  // a tool result before it starts writing its next response.
  const isWaiting = sessionStreaming && !isStreaming;
  const lastToolStepIdx = messages.reduce((acc, m, i) => (m.role === "tool_step" ? i : acc), -1);
  const hasTextAfterLastTool =
    lastToolStepIdx !== -1 &&
    messages.slice(lastToolStepIdx + 1).some((m) => m.role === "assistant" && m.content.length > 0);
  const activeToolStepId =
    lastToolStepIdx !== -1 && !hasTextAfterLastTool ? messages[lastToolStepIdx].id : null;

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    userScrolledRef.current = el.scrollHeight - el.scrollTop - el.clientHeight > 80;
  };

  // ResizeObserver on the inner content div: fires on every height change (streaming text,
  // entry animations, accordion expand/collapse) so scroll follows frame-by-frame
  useEffect(() => {
    const el = containerRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (!userScrolledRef.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  // When the session finishes, always snap to bottom regardless of scroll position
  useEffect(() => {
    if (!sessionStreaming) {
      userScrolledRef.current = false;
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [sessionStreaming]);

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 pt-3">
      <div ref={innerRef}>
        {messages.map((msg) => {
          if (msg.role === "tool_step" && msg.toolStep) {
            return (
              <AnimatedItem key={msg.id}>
                <div className="flex justify-start">
                  <div className="max-w-[85%]">
                    <ToolStepItem step={msg.toolStep} isActive={msg.id === activeToolStepId} />
                  </div>
                </div>
              </AnimatedItem>
            );
          }
          return (
            <AnimatedItem key={msg.id}>
              <div className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className="flex max-w-[85%] flex-col">
                  {msg.role === "user" ? <UserBubble msg={msg} /> : <AssistantBubble msg={msg} />}
                  {msg.role === "assistant" && msg.inputTokens != null && !msg.isStreaming && (
                    <UsageFooter msg={msg} />
                  )}
                </div>
              </div>
            </AnimatedItem>
          );
        })}
        {isWaiting && (
          <div className="px-1 pb-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground/40" />
          </div>
        )}
      </div>
    </div>
  );
}
