'use client';

import { Workflow, Sparkle, Bot, Wrench, ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TREE_LAYOUT } from '../utils';

/**
 * Get the icon component for a span kind
 */
export function getSpanKindIcon(kind: string) {
  const normalizedKind = kind.toLowerCase();
  switch (normalizedKind) {
    case 'trace':
      return Workflow;
    case 'llm':
      return Sparkle;
    case 'agent':
      return Bot;
    case 'tool':
      return Wrench;
    case 'span':
    default:
      return ArrowRight;
  }
}

interface SpanKindIconProps {
  kind: string;
  size?: 'sm' | 'md';
  selected?: boolean;
  inTree?: boolean;
}

/**
 * Icon component for displaying span kinds (trace, llm, agent, tool, etc.)
 */
export function SpanKindIcon({ kind, size = 'sm', selected = false, inTree = false }: SpanKindIconProps) {
  const Icon = getSpanKindIcon(kind);
  const iconSizeClass = size === 'md' ? 'h-4 w-4' : 'h-3 w-3';

  // In tree view, show icon with white background box
  if (inTree) {
    return (
      <div
        className="flex items-center justify-center rounded border bg-background flex-shrink-0"
        style={{ width: TREE_LAYOUT.ICON_BOX_SIZE, height: TREE_LAYOUT.ICON_BOX_SIZE }}
      >
        <Icon className="h-3 w-3 text-muted-foreground" />
      </div>
    );
  }

  // In detail panel, just show the icon
  return (
    <Icon className={cn(
      iconSizeClass,
      selected ? 'text-current' : 'text-muted-foreground'
    )} />
  );
}
