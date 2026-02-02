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
    <div className="border border-gray-200 rounded-md overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-2.5 py-1.5 bg-gray-50 hover:bg-gray-100 transition-colors border-b border-gray-200"
      >
        <div className="flex items-center gap-1.5">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-gray-500" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-gray-500" />
          )}
          <span className="text-xs font-medium text-gray-700">{title}</span>
        </div>
        {onCopy && (
          <div
            onClick={(e) => {
              e.stopPropagation();
              onCopy();
            }}
            className="text-gray-400 hover:text-gray-600 transition-colors p-0.5"
            title="Copy"
          >
            <Copy className="h-3 w-3" />
          </div>
        )}
      </button>
      {isOpen && (
        <div className="px-2.5 py-2 bg-white">
          {children}
        </div>
      )}
    </div>
  );
}
