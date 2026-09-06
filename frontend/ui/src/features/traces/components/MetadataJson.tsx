"use client";

/**
 * A trace's metadata as a JSON document — braces, quoted keys, separating commas — rather
 * than the tree `JsonRenderer` draws, which wraps its values and truncates a string only at
 * 500 characters, enough to fill this 22rem popover several times over, and leaves keys
 * unquoted where these are `JSON.stringify`'d. Metadata is one level deep by construction
 * (the map's values are text), so there is nothing to collapse and no depth to indent for,
 * and reading it as the document it is beats reading a rendering of it.
 */
import { cn } from "@/lib/utils";
import type { MetadataEntry } from "../utils/metadata";

/** Long enough for a version, a slug, or an id; short enough that no line wraps. */
const MAX_VALUE_CHARS = 42;

/** Cuts on code points, so a slice can never leave half a surrogate pair behind. */
function shorten(text: string): string {
  const chars = Array.from(text);
  return chars.length <= MAX_VALUE_CHARS ? text : chars.slice(0, MAX_VALUE_CHARS).join("");
}

/** The value in its JSON spelling, shortened inside the quotes so a string still reads as one. */
function valueText(rawValue: unknown): string {
  if (typeof rawValue === "string") {
    // Shorten first, then serialize: escaping text that is already short cannot produce a
    // half-written escape sequence, which slicing the serialized form can.
    const shortened = shorten(rawValue);
    const serialized = JSON.stringify(shortened);
    return shortened === rawValue ? serialized : `${serialized.slice(0, -1)}…"`;
  }
  const serialized = JSON.stringify(rawValue) ?? "null";
  const shortened = shorten(serialized);
  return shortened === serialized ? serialized : `${shortened}…`;
}

interface MetadataJsonProps {
  entries: readonly MetadataEntry[];
  className?: string;
}

export function MetadataJson({ entries, className }: MetadataJsonProps) {
  return (
    <div className={cn("font-mono text-[11px] leading-[1.7] text-foreground", className)}>
      <div>{"{"}</div>
      {entries.map((entry, index) => (
        <div key={entry.key} className="whitespace-nowrap pl-4">
          {/* Serialized, not wrapped in literal quotes: a key holding a quote or a backslash
              has to appear escaped, or the line stops being the document it claims to be. */}
          <span className="text-blue-600 dark:text-blue-400">{JSON.stringify(entry.key)}</span>
          <span className="text-muted-foreground">: </span>
          <span>{valueText(entry.rawValue)}</span>
          {index < entries.length - 1 && <span className="text-muted-foreground">,</span>}
        </div>
      ))}
      <div>{"}"}</div>
    </div>
  );
}
