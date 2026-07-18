"use client";

import { cn } from "@/lib/utils";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { TREE_LAYOUT } from "../utils";

/**
 * Get the icon component for a span kind
 */
export function getSpanKindIcon(kind: string) {
  const normalizedKind = kind.toLowerCase();
  switch (normalizedKind) {
    case "trace":
      return DOMAIN_ICONS.trace;
    case "llm":
      return DOMAIN_ICONS.llm;
    case "agent":
      return DOMAIN_ICONS.agent;
    case "tool":
      return DOMAIN_ICONS.tool;
    case "span":
    default:
      return DOMAIN_ICONS.span;
  }
}

export interface SpanKindColor {
  /** Tailwind bg + border classes for timeline bars, tree icon boxes, legend swatches. */
  surface: string;
  /** Tailwind text color for the tree icon glyph. */
  glyph: string;
}

/**
 * Color palette keyed by span_kind. Colocated with getSpanKindIcon so icon and
 * color stay in sync. Soft tints (-100 fill / -300 border) keep bars quiet
 * relative to text and chips; ERROR red is applied separately and overrides this.
 */
const SPAN_KIND_COLORS: Record<string, SpanKindColor> = {
  llm: {
    surface: "bg-violet-100 border-violet-300 dark:bg-violet-950/50 dark:border-violet-800",
    glyph: "text-violet-700 dark:text-violet-300",
  },
  agent: {
    surface: "bg-blue-100 border-blue-300 dark:bg-blue-950/50 dark:border-blue-800",
    glyph: "text-blue-700 dark:text-blue-300",
  },
  tool: {
    surface: "bg-amber-100 border-amber-300 dark:bg-amber-950/50 dark:border-amber-800",
    glyph: "text-amber-700 dark:text-amber-300",
  },
  span: {
    surface: "bg-slate-100 border-slate-300 dark:bg-slate-800/50 dark:border-slate-700",
    glyph: "text-slate-600 dark:text-slate-400",
  },
  // The trace root is structural, not a real span_kind — keep it neutral/quiet.
  trace: {
    surface: "bg-background border-border",
    glyph: "text-muted-foreground",
  },
};

/**
 * Resolve the color tint for a span kind. Unknown kinds fall back to the neutral
 * "span" tint, mirroring getSpanKindIcon's default.
 */
export function getSpanKindColor(kind: string): SpanKindColor {
  return SPAN_KIND_COLORS[kind.toLowerCase()] ?? SPAN_KIND_COLORS.span;
}

interface SpanKindIconProps {
  kind: string;
  size?: "sm" | "md";
  selected?: boolean;
  inTree?: boolean;
}

/**
 * Icon component for displaying span kinds (trace, llm, agent, tool, etc.)
 */
export function SpanKindIcon({
  kind,
  size = "sm",
  selected = false,
  inTree = false,
}: SpanKindIconProps) {
  const Icon = getSpanKindIcon(kind);
  const iconSizeClass = size === "md" ? "h-4 w-4" : "h-3 w-3";

  // In tree view, show icon in a box tinted by span kind
  if (inTree) {
    const color = getSpanKindColor(kind);
    return (
      <div
        className={cn(
          "flex flex-shrink-0 items-center justify-center rounded border",
          color.surface,
        )}
        style={{ width: TREE_LAYOUT.ICON_BOX_SIZE, height: TREE_LAYOUT.ICON_BOX_SIZE }}
      >
        <Icon className={cn("h-3 w-3", color.glyph)} />
      </div>
    );
  }

  // In detail panel, just show the icon
  return (
    <Icon className={cn(iconSizeClass, selected ? "text-current" : "text-muted-foreground")} />
  );
}
