"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";

interface ExpandableSectionProps {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  onCopy?: () => void;
}

/**
 * Expandable/collapsible section component with optional copy button
 */
export function ExpandableSection({
  title,
  children,
  defaultOpen = true,
  onCopy,
}: ExpandableSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="overflow-hidden rounded-md border border-border">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between border-b border-border bg-muted/50 px-2.5 py-1.5 transition-colors hover:bg-muted"
      >
        <div className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-xs font-medium text-foreground">{title}</span>
        </div>
        {onCopy && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
            }}
            className="p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            title="Copy"
          >
            <Copy className="h-3 w-3" />
          </div>
        )}
      </button>
      {isOpen && <div className="bg-background px-2.5 py-2">{children}</div>}
    </div>
  );
}
