"use client";

import {
  Children,
  isValidElement,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, Loader2, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AIMessage, ToolCallStep } from "../types";
import { PANEL_MAX_WIDTH } from "../constants";
import {
  createdWidgetsByDashboard,
  pendingCardModel,
  resourceCardModel,
  suppressedWidgetStepIds,
} from "../lib/resource-card";
import { ResourceCard } from "./resource-card";
import { PendingResourceCard } from "./pending-resource-card";

// ---------------------------------------------------------------------------
// Lightweight markdown normalization for streamed, partial content.
// Keeps rendering stable by auto-closing unbalanced fences.
// ---------------------------------------------------------------------------
function normalizeStreamingMarkdown(
  input: string,
  {
    normalizeHeadings,
    closeUnbalancedFences,
  }: { normalizeHeadings: boolean; closeUnbalancedFences: boolean },
): string {
  let text = input || "";

  if (normalizeHeadings) {
    // Ensure headings that immediately follow text (no blank line) still parse.
    text = text.replace(/(^|[^\n])(#{1,6} )/g, "$1\n\n$2");
  }

  if (closeUnbalancedFences) {
    // Auto-close unbalanced fenced code blocks while streaming.
    const backtickFenceCount = (text.match(/```/g) || []).length;
    if (backtickFenceCount % 2 === 1) {
      text = `${text}\n\`\`\``;
    }

    const tildeFenceCount = (text.match(/~~~/g) || []).length;
    if (tildeFenceCount % 2 === 1) {
      text = `${text}\n~~~`;
    }
  }

  return text;
}

interface ParsedMarkdownTable {
  headers: string[];
  rows: ReactNode[][];
  columnCount: number;
  maxCellTextLength: number;
}

type TableRenderMode = "table" | "card" | "stacked";

function isTagElement(
  node: ReactNode,
  tag: string,
): node is ReactElement<{ children?: ReactNode }> {
  return isValidElement(node) && typeof node.type === "string" && node.type === tag;
}

function flattenNodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenNodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenNodeText(node.props.children);
  }
  return "";
}

function getTableRowCells(trNode: ReactNode): ReactNode[] {
  if (!isTagElement(trNode, "tr")) return [];
  return Children.toArray(trNode.props.children)
    .filter(
      (cell): cell is ReactElement<{ children?: ReactNode }> =>
        isTagElement(cell, "td") || isTagElement(cell, "th"),
    )
    .map((cell) => cell.props.children);
}

function parseMarkdownTable(children: ReactNode): ParsedMarkdownTable | null {
  const headers: string[] = [];
  const rows: ReactNode[][] = [];
  let maxCellTextLength = 0;

  for (const node of Children.toArray(children)) {
    if (isTagElement(node, "thead")) {
      const headerRow = Children.toArray(node.props.children).find((child) =>
        isTagElement(child, "tr"),
      );
      if (headerRow) {
        headers.push(
          ...getTableRowCells(headerRow).map((cell, idx) => {
            const text = flattenNodeText(cell).trim();
            const resolvedText = text || `Column ${idx + 1}`;
            maxCellTextLength = Math.max(maxCellTextLength, resolvedText.length);
            return resolvedText;
          }),
        );
      }
      continue;
    }

    if (isTagElement(node, "tbody")) {
      for (const tr of Children.toArray(node.props.children)) {
        const cells = getTableRowCells(tr);
        if (cells.length > 0) {
          for (const cell of cells) {
            maxCellTextLength = Math.max(maxCellTextLength, flattenNodeText(cell).trim().length);
          }
          rows.push(cells);
        }
      }
      continue;
    }
  }

  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 0);
  if (columnCount === 0 || rows.length === 0) return null;

  const normalizedHeaders =
    headers.length > 0
      ? [
          ...headers,
          ...Array.from({ length: Math.max(0, columnCount - headers.length) }, (_, i) => {
            return `Column ${headers.length + i + 1}`;
          }),
        ]
      : Array.from({ length: columnCount }, (_, i) => `Column ${i + 1}`);

  return {
    headers: normalizedHeaders,
    rows,
    columnCount,
    maxCellTextLength,
  };
}

interface MarkdownLayoutOptions {
  containerWidth: number;
}

const TABLE_MODE_WIDE_BREAKPOINT = Math.round(PANEL_MAX_WIDTH * 0.91);
const TABLE_MODE_MEDIUM_BREAKPOINT = Math.round(PANEL_MAX_WIDTH * 0.69);
const TABLE_MODE_NARROW_BREAKPOINT = Math.round(PANEL_MAX_WIDTH * 0.51);

function getTableRenderMode(parsed: ParsedMarkdownTable, containerWidth: number): TableRenderMode {
  if (containerWidth >= TABLE_MODE_WIDE_BREAKPOINT) {
    if (parsed.columnCount <= 6 && parsed.maxCellTextLength <= 72) return "table";
    if (parsed.columnCount <= 4) return "table";
    return "card";
  }

  if (containerWidth >= TABLE_MODE_MEDIUM_BREAKPOINT) {
    if (parsed.columnCount <= 4 && parsed.maxCellTextLength <= 52) return "table";
    return "card";
  }

  if (containerWidth >= TABLE_MODE_NARROW_BREAKPOINT) {
    if (parsed.columnCount <= 3 && parsed.maxCellTextLength <= 40) return "table";
    return "stacked";
  }

  return "stacked";
}

function getCardLabelColumnWidth(containerWidth: number): number {
  return Math.min(180, Math.max(84, Math.round(containerWidth * 0.24)));
}

// ---------------------------------------------------------------------------
// Markdown renderer config - only override what prose can't handle
// ---------------------------------------------------------------------------
function getMarkdownComponents(layout: MarkdownLayoutOptions): Components {
  const labelColWidth = getCardLabelColumnWidth(layout.containerWidth);

  return {
    // Keep wide blocks constrained to bubble width and readable at all panel widths.
    pre: ({ children, ...props }) => (
      <pre
        className="max-w-full whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-foreground [overflow-wrap:anywhere]"
        {...props}
      >
        {children}
      </pre>
    ),
    table: ({ children, ...props }) => {
      const parsed = parseMarkdownTable(children);
      const mode = parsed ? getTableRenderMode(parsed, layout.containerWidth) : "table";

      if (parsed && mode === "stacked") {
        return (
          <div className="my-2 space-y-2">
            {parsed.rows.map((row, rowIndex) => (
              <div
                key={rowIndex}
                className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5"
              >
                {Array.from({ length: parsed.columnCount }).map((_, colIndex) => (
                  <div key={colIndex} className="border-b border-border/40 py-1.5 last:border-b-0">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                      {parsed.headers[colIndex]}
                    </div>
                    <div className="mt-0.5 min-w-0 break-words [overflow-wrap:anywhere]">
                      {row[colIndex] ?? "-"}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      }

      if (parsed && mode === "card") {
        return (
          <div className="my-2 space-y-2">
            {parsed.rows.map((row, rowIndex) => (
              <div
                key={rowIndex}
                className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5"
              >
                {Array.from({ length: parsed.columnCount }).map((_, colIndex) => (
                  <div
                    key={colIndex}
                    className="grid gap-x-2 border-b border-border/40 py-1 last:border-b-0"
                    style={{ gridTemplateColumns: `${labelColWidth}px minmax(0, 1fr)` }}
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                      {parsed.headers[colIndex]}
                    </span>
                    <div className="min-w-0 break-words [overflow-wrap:anywhere]">
                      {row[colIndex] ?? "-"}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      }

      return (
        <table
          className="my-2 w-full table-auto border-collapse text-[11px] [&_td]:whitespace-normal [&_td]:break-words [&_td]:border [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top [&_td]:[overflow-wrap:anywhere] [&_th]:whitespace-normal [&_th]:break-words [&_th]:border [&_th]:border-border/60 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:align-top [&_th]:[overflow-wrap:anywhere]"
          {...props}
        >
          {children}
        </table>
      );
    },
    // Custom block/inline detection - prose styles pre/code but can't detect
    // unlabelled fences (no language-* class) without this heuristic
    code: ({ className, children, ...props }) => {
      const isBlock = className?.includes("language-") || String(children).includes("\n");
      return isBlock ? (
        <code
          className="block whitespace-pre-wrap break-words text-foreground [overflow-wrap:anywhere]"
          {...props}
        >
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
}

// ---------------------------------------------------------------------------
// AnimatedItem - grows from 0 height on mount so new items slide in smoothly
// ---------------------------------------------------------------------------
function AnimatedItem({ children }: { children: ReactNode }) {
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

/** Cap the revision text shown on the tool line; the full text stays in the result. */
const REVISED_NOTE_MAX_CHARS = 80;

function revisedNote(text: string): string {
  const trimmed =
    text.length > REVISED_NOTE_MAX_CHARS ? `${text.slice(0, REVISED_NOTE_MAX_CHARS)}…` : text;
  return `revised — ${trimmed}`;
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
        {/* A declined call (skipped or revised) was not broken — its line stays muted. */}
        {step.skipped || step.revisedText !== undefined ? (
          <XCircle className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        ) : (
          <>
            {step.status === "running" && (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/60" />
            )}
            {step.status === "done" && (
              <CheckCircle2 className="h-3 w-3 shrink-0 text-green-500/70" />
            )}
            {step.status === "error" && (
              <XCircle className="h-3 w-3 shrink-0 text-destructive/70" />
            )}
          </>
        )}
        <span className="italic text-muted-foreground/80">{formatToolName(step.toolName)}</span>
        <span className="font-mono text-[10px] text-muted-foreground/40">({step.toolName})</span>
        {step.skipped ? (
          <span className="text-muted-foreground/60">skipped</span>
        ) : (
          step.revisedText !== undefined && (
            <span className="min-w-0 flex-1 truncate text-left text-muted-foreground/60">
              {revisedNote(step.revisedText)}
            </span>
          )
        )}
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
                    step.isError && !step.skipped && step.revisedText === undefined
                      ? "text-destructive/70"
                      : "text-muted-foreground/50",
                  )}
                >
                  {step.skipped
                    ? "Skipped"
                    : step.revisedText !== undefined
                      ? "Revised"
                      : step.isError
                        ? "Error"
                        : "Result"}
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

/**
 * One tool-step row of the transcript, with the card model derived inside so
 * it lives behind this memo boundary. Streamed text deltas rebuild the
 * messages array many times a second, but every prop here is stable across a
 * delta-only update (the step objects survive by identity, and the derived
 * maps are pinned by useStableToolSteps) — so neither the model derivation
 * nor the preview subtrees rerun per delta.
 */
const ToolStepEntry = memo(function ToolStepEntry({
  step,
  suppressed,
  widgetsByDashboard,
  projectId,
  retentionDays,
  isActive,
  bubbleMaxWidth,
}: {
  step: ToolCallStep;
  /** True when this widget's card would duplicate the preview of a CREATED
   *  dashboard's card above it (a reused dashboard draws none). */
  suppressed: boolean;
  widgetsByDashboard: ReadonlyMap<string, readonly ToolCallStep[]>;
  projectId?: string;
  /** The plan's retention window, which clamps every card's charted range.
   *  Undefined while the plan is still resolving — nothing is clamped then. */
  retentionDays?: number | null;
  isActive: boolean;
  bubbleMaxWidth: string;
}) {
  // A parked write shows the card BEFORE the resource exists, marked
  // proposed; the decision itself is taken at the composer (create/skip
  // buttons there, or a typed reply that revises). The tool result (or a
  // posted decision) clears `pending` and the step falls through to the
  // receipt flow.
  const pendingCard = useMemo(
    () => (step.pending ? pendingCardModel(step, projectId, retentionDays) : null),
    [step, projectId, retentionDays],
  );
  // A write that created something we can show becomes its card; every other
  // step — and every write we can't read a resource out of, or whose card
  // would duplicate a created dashboard's preview above it — keeps the
  // plain expandable tool line.
  const card = useMemo(
    () =>
      pendingCard !== null || suppressed
        ? null
        : resourceCardModel(step, widgetsByDashboard, retentionDays),
    [pendingCard, suppressed, step, widgetsByDashboard, retentionDays],
  );
  return (
    <AnimatedItem>
      <div className="flex justify-start">
        {/* Cards span the message column — the width text bubbles get — so
            every card shares one edge instead of each sizing to its content. */}
        <div
          className={cn("min-w-0", (card !== null || pendingCard !== null) && "w-full")}
          style={{ maxWidth: bubbleMaxWidth }}
        >
          {pendingCard ? (
            <PendingResourceCard model={pendingCard} />
          ) : card ? (
            <ResourceCard model={card} />
          ) : (
            <ToolStepItem step={step} isActive={isActive} />
          )}
        </div>
      </div>
    </AnimatedItem>
  );
});

/**
 * The transcript's tool-step entries, identity-stable across renders that
 * changed none of them. A streamed delta replaces the messages array on every
 * tick while reusing each untouched tool-step object, so pinning this list to
 * its previous identity (when its members are unchanged) lets everything
 * derived from the tool steps — and the memoized rows above — stand still
 * under streaming text.
 */
function useStableToolSteps(messages: readonly AIMessage[]): readonly AIMessage[] {
  const prevRef = useRef<readonly AIMessage[]>([]);
  const next = messages.filter((m) => m.role === "tool_step" && m.toolStep !== undefined);
  const prev = prevRef.current;
  const unchanged = prev.length === next.length && next.every((m, i) => m === prev[i]);
  if (!unchanged) prevRef.current = next;
  return unchanged ? prev : next;
}

function AssistantBubble({ msg, panelWidth }: { msg: AIMessage; panelWidth: number }) {
  const normalizedContent = useMemo(
    () =>
      normalizeStreamingMarkdown(msg.content, {
        normalizeHeadings: !!msg.isStreaming,
        closeUnbalancedFences: !!msg.isStreaming,
      }),
    [msg.content, msg.isStreaming],
  );
  const markdownComponents = useMemo(
    () => getMarkdownComponents({ containerWidth: Math.max(280, panelWidth) }),
    [panelWidth],
  );

  return (
    <div className="overflow-hidden break-words rounded-md border border-border bg-background px-3 py-1.5 text-xs text-foreground">
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
      <div className="prose prose-sm prose-neutral max-w-none dark:prose-invert [&_*]:text-xs [&_pre]:max-w-full">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          children={normalizedContent}
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
      <span>&middot;</span>
      <span title="Output tokens">{msg.outputTokens!.toLocaleString()} out</span>
      {msg.totalTokens != null && (
        <>
          <span>&middot;</span>
          <span title="Cumulative session tokens">{msg.totalTokens.toLocaleString()} session</span>
        </>
      )}
      {msg.costUsd != null && msg.costUsd > 0 && (
        <>
          <span>&middot;</span>
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
  /** The project the panel is mounted in — a pending widget card aims its
   *  chart preview here, the scope the proposed write would land in. */
  projectId?: string;
  /** The plan's retention window. It clamps the range every card charts and
   *  labels, so a selection left in storage by a workspace that has since
   *  downgraded is neither queried nor named. Undefined while the plan is
   *  still resolving, and with no project to look one up by. */
  retentionDays?: number | null;
}

export function MessageList({
  messages,
  sessionStreaming = false,
  projectId,
  retentionDays,
}: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [panelWidth, setPanelWidth] = useState(400);
  const isStreaming = messages.some((m) => m.isStreaming);
  // Derived off the identity-stable tool-step list, not `messages`: a delta
  // replaces the array per tick, and rebuilding these maps then would churn
  // the memoized rows' props on every keystroke of streamed text.
  const toolSteps = useStableToolSteps(messages);
  // A dashboard's widget count lives nowhere in its own call — the widgets are
  // separate calls that land after it — so it is read back off the transcript.
  const widgetsByDashboard = useMemo(() => createdWidgetsByDashboard(toolSteps), [toolSteps]);
  // A widget created into a CREATED (not reused) dashboard carded earlier in
  // this transcript keeps the plain tool line: that dashboard's preview
  // already draws it, and a second card right under the preview reads as a
  // duplicate. A reused dashboard's card draws no preview, so its widget
  // cards stay.
  const suppressedWidgets = useMemo(() => suppressedWidgetStepIds(toolSteps), [toolSteps]);
  // True when the session is active but no text bubble is open - the LLM is processing
  // a tool result before it starts writing its next response. Not while a call is
  // parked on a confirmation card: the run is alive, but it is waiting on the
  // user, and a spinner there reads as "still generating".
  const hasPendingDecision = toolSteps.some((m) => m.toolStep?.pending !== undefined);
  const isWaiting = sessionStreaming && !isStreaming && !hasPendingDecision;
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

  // Shared ResizeObserver:
  // - innerRef height changes: keep auto-scroll behavior frame-by-frame while streaming.
  // - containerRef width changes: drive responsive markdown/table layouts.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;

    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === inner) {
          if (!userScrolledRef.current) container.scrollTop = container.scrollHeight;
          continue;
        }

        if (entry.target === container) {
          const next = Math.round(entry.contentRect.width || container.clientWidth);
          if (next > 0) setPanelWidth(next);
        }
      }
    });

    ro.observe(inner);
    ro.observe(container);
    setPanelWidth(container.clientWidth);
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

  const bubbleMaxWidth =
    panelWidth >= 860 ? "96%" : panelWidth >= 700 ? "94%" : panelWidth >= 520 ? "92%" : "90%";

  return (
    <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 pt-3">
      <div ref={innerRef}>
        {messages.map((msg) => {
          if (msg.role === "tool_step" && msg.toolStep) {
            return (
              <ToolStepEntry
                key={msg.id}
                step={msg.toolStep}
                suppressed={suppressedWidgets.has(msg.id)}
                widgetsByDashboard={widgetsByDashboard}
                projectId={projectId}
                retentionDays={retentionDays}
                isActive={msg.id === activeToolStepId}
                bubbleMaxWidth={bubbleMaxWidth}
              />
            );
          }
          return (
            <AnimatedItem key={msg.id}>
              <div className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className="flex min-w-0 flex-col" style={{ maxWidth: bubbleMaxWidth }}>
                  {msg.role === "user" ? (
                    <UserBubble msg={msg} />
                  ) : (
                    <AssistantBubble msg={msg} panelWidth={panelWidth} />
                  )}
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
