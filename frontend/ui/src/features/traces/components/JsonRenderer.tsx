"use client";

import { useState } from "react";

import { InlineMedia, mediaSrc } from "./inline-media";
import {
  STRING_TRUNCATE_AT,
  shouldAutoExpand,
  shouldTruncate,
  truncateString,
} from "./json-render-utils";

interface JsonRendererProps {
  value: unknown;
  depth?: number;
}

/**
 * A long string value, truncated by default with a "…expand (N more characters)"
 * control on its own line (blank line above) so it's easy to spot. Expand-only:
 * there is no "collapse" affordance — the value re-collapses when the selected
 * span/trace changes, because the renderer is keyed by selection at the panel.
 * Truncated by default so a single very large field never floods the DOM. The
 * control inherits the surrounding font size and has no underline.
 */
function TruncatableString({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);

  // Full value once expanded, or when it was never long enough to truncate.
  if (expanded || !shouldTruncate(value)) {
    return (
      <span className="whitespace-pre-wrap break-words text-green-700 dark:text-green-400">
        &quot;{value}&quot;
      </span>
    );
  }

  const hiddenCount = value.length - STRING_TRUNCATE_AT;

  // The surrounding span is whitespace-pre-wrap, so the explicit newlines put
  // the control on its own line, with a blank line above, to make it easy to spot.
  return (
    <span className="whitespace-pre-wrap break-words text-green-700 dark:text-green-400">
      &quot;{truncateString(value)}
      {"\n\n"}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="cursor-pointer align-baseline text-muted-foreground hover:text-foreground"
      >
        ...expand ({hiddenCount} more characters)
      </button>
      {"\n"}&quot;
    </span>
  );
}

/**
 * A nested object/array. Shallow, small nodes start expanded (`defaultExpanded`)
 * so a normal span's I/O is readable on first paint; deep or large nodes start
 * collapsed, showing the bracket and entry count, and expand their children on
 * demand so we never render thousands of nested rows up front.
 */
function CollapsibleNode({
  open,
  close,
  count,
  defaultExpanded,
  children,
}: {
  open: string;
  close: string;
  count: number;
  defaultExpanded: boolean;
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="cursor-pointer text-left align-baseline"
      >
        <span className="text-muted-foreground">{open}</span>
        <span className="mx-0.5 text-[10px] text-muted-foreground">
          {count} {count === 1 ? "item" : "items"}
        </span>
        <span className="text-muted-foreground">{close}</span>
      </button>
    );
  }

  // Block container, not a <span>: the children wrapper below is a <div>, which
  // is invalid nested inside an inline <span> and warns during hydration.
  return (
    <div className="inline">
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="cursor-pointer align-baseline text-muted-foreground"
      >
        {open}
      </button>
      <div className="ml-3">{children}</div>
      <span className="text-muted-foreground">{close}</span>
    </div>
  );
}

/**
 * Recursive JSON renderer with syntax highlighting.
 *
 * Long string values are truncated behind a toggle, and deep or large nested
 * objects/arrays start collapsed (shallow, small ones stay expanded), so
 * selecting a span with a large I/O blob renders without a main-thread stall
 * instead of materializing the entire expanded tree at once.
 */
export function JsonRenderer({ value, depth = 0 }: JsonRendererProps) {
  if (value === null) {
    return <span className="text-orange-600 dark:text-orange-400">null</span>;
  }

  if (typeof value === "boolean") {
    return <span className="text-purple-600 dark:text-purple-400">{value ? "true" : "false"}</span>;
  }

  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  }

  if (typeof value === "string") {
    // Render inline base64 media (data URIs and bare base64) as image/audio.
    const media = mediaSrc(value);
    if (media) {
      return <InlineMedia {...media} />;
    }

    // Try to parse JSON strings and render them as structured objects
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "object" && parsed !== null && depth < 10) {
          return <JsonRenderer value={parsed} depth={depth} />;
        }
      } catch {
        // Not valid JSON, render as plain string
      }
    }
    return <TruncatableString value={value} />;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">[]</span>;
    }

    return (
      <CollapsibleNode
        open="["
        close="]"
        count={value.length}
        defaultExpanded={shouldAutoExpand(depth, value.length)}
      >
        {value.map((item, index) => (
          <div key={index}>
            <JsonRenderer value={item} depth={depth + 1} />
            {index < value.length - 1 && <span className="text-muted-foreground">,</span>}
          </div>
        ))}
      </CollapsibleNode>
    );
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) {
      return <span className="text-muted-foreground">{"{}"}</span>;
    }

    return (
      <CollapsibleNode
        open="{"
        close="}"
        count={keys.length}
        defaultExpanded={shouldAutoExpand(depth, keys.length)}
      >
        {keys.map((key, index) => (
          <div key={key}>
            <span className="text-sky-600 dark:text-sky-400">{key}</span>
            <span className="text-muted-foreground">: </span>
            <JsonRenderer value={(value as Record<string, unknown>)[key]} depth={depth + 1} />
            {index < keys.length - 1 && <span className="text-muted-foreground">,</span>}
          </div>
        ))}
      </CollapsibleNode>
    );
  }

  return <span>{String(value)}</span>;
}
