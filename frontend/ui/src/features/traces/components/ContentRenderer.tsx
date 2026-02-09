"use client";

import { JsonRenderer } from "./JsonRenderer";

interface ContentRendererProps {
  content: string | null;
}

/**
 * Smart content renderer - attempts to parse and render JSON, falls back to plain text
 */
export function ContentRenderer({ content }: ContentRendererProps) {
  if (!content) {
    return <span className="text-[11px] text-muted-foreground">-</span>;
  }

  // Try to parse as JSON
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null) {
      return (
        <div className="font-mono text-[11px] leading-relaxed">
          <JsonRenderer value={parsed} />
        </div>
      );
    }
    // If it's a primitive after parsing, just show it
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {content}
      </pre>
    );
  } catch {
    // Not valid JSON, show as plain text
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {content}
      </pre>
    );
  }
}
