"use client";

import { JsonRenderer } from "./JsonRenderer";
import { InlineMedia, mediaSrc } from "./inline-media";

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

  // A bare media string (data URI or raw base64) won't reach JsonRenderer, so
  // detect it here too.
  const directMedia = mediaSrc(content);
  if (directMedia) {
    return <InlineMedia {...directMedia} />;
  }

  // Try to parse as JSON; on failure fall back to the raw text. Either way the
  // value is rendered through JsonRenderer, which truncates long strings behind
  // a "show more" toggle and starts nested objects collapsed so selecting a
  // span with a large I/O blob doesn't flood the DOM on click.
  let value: unknown = content;
  try {
    value = JSON.parse(content);
  } catch {
    // Not valid JSON — render the raw text.
  }
  return (
    <div className="font-mono text-[11px] leading-relaxed">
      <JsonRenderer value={value} />
    </div>
  );
}
