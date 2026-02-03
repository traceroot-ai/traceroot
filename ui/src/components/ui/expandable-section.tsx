'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';

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
    <div className="border border-border rounded-md overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-2.5 py-1.5 bg-muted/50 hover:bg-muted transition-colors border-b border-border"
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
            className="text-muted-foreground hover:text-foreground transition-colors p-0.5"
            title="Copy"
          >
            <Copy className="h-3 w-3" />
          </div>
        )}
      </button>
      {isOpen && (
        <div className="px-2.5 py-2 bg-background">
          {children}
        </div>
      )}
    </div>
  );
}
