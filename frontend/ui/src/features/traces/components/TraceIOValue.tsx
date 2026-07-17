"use client";

import { useMemo, useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { MarkdownView } from "@/components/ui/markdown-view";
import { cn } from "@/lib/utils";
import { ContentRenderer } from "./ContentRenderer";

/**
 * A collapsible span I/O / metadata section with a format switcher in its header
 * (beside the copy button), matching the editable fields' chrome. Formats: Pretty
 * (the smart JSON tree / media renderer — the default), JSON (flat, syntax-highlighted),
 * Text (raw), and YAML. The value is parsed as JSON when possible; a non-JSON string is
 * shown as-is.
 */
type IOFormat = "pretty" | "json" | "text" | "yaml" | "markdown";

const FORMAT_LABEL: Record<IOFormat, string> = {
  pretty: "Pretty",
  json: "JSON",
  text: "Text",
  yaml: "YAML",
  markdown: "Markdown",
};
const FORMATS: IOFormat[] = ["pretty", "json", "text", "yaml", "markdown"];

function parseMaybe(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Minimal YAML for the shapes span I/O holds (scalars, flat-ish objects/arrays). */
function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}null`;
  if (typeof value === "string") {
    if (value.includes("\n")) {
      return `${pad}|\n${value
        .split("\n")
        .map((line) => `${pad}  ${line}`)
        .join("\n")}`;
    }
    return `${pad}${value}`;
  }
  if (typeof value === "number" || typeof value === "boolean") return `${pad}${value}`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value
      .map((item) =>
        item !== null && typeof item === "object"
          ? `${pad}-\n${toYaml(item, indent + 1)}`
          : `${pad}- ${toText(item)}`,
      )
      .join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${pad}{}`;
  return entries
    .map(([k, v]) =>
      v !== null && typeof v === "object"
        ? `${pad}${k}:\n${toYaml(v, indent + 1)}`
        : `${pad}${k}: ${toText(v)}`,
    )
    .join("\n");
}

function formatValue(value: unknown, format: "text" | "yaml"): string {
  return format === "yaml" ? toYaml(value) : toText(value);
}

/**
 * JSON syntax highlighting for the flat "JSON" view, mirroring the palette the
 * interactive tree (JsonRenderer) uses so switching formats keeps the coloring:
 * keys sky, strings green, numbers blue, booleans purple, null orange, and the
 * structural punctuation muted. A single regex tokenizes the serialized JSON; a
 * quoted token is a key when a colon follows it, otherwise a string value.
 */
const JSON_TOKEN = /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
const JSON_TOKEN_CLASS: Record<string, string> = {
  key: "text-sky-600 dark:text-sky-400",
  string: "text-green-700 dark:text-green-400",
  number: "text-blue-600 dark:text-blue-400",
  bool: "text-purple-600 dark:text-purple-400",
  null: "text-orange-600 dark:text-orange-400",
};

function tokenizeJson(json: string): Array<{ text: string; kind?: string }> {
  const out: Array<{ text: string; kind?: string }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  JSON_TOKEN.lastIndex = 0;
  while ((m = JSON_TOKEN.exec(json)) !== null) {
    if (m.index > last) out.push({ text: json.slice(last, m.index) });
    const raw = m[0];
    let kind: string;
    if (raw[0] === '"') {
      kind = /^\s*:/.test(json.slice(JSON_TOKEN.lastIndex)) ? "key" : "string";
    } else if (raw === "true" || raw === "false") {
      kind = "bool";
    } else if (raw === "null") {
      kind = "null";
    } else {
      kind = "number";
    }
    out.push({ text: raw, kind });
    last = JSON_TOKEN.lastIndex;
  }
  if (last < json.length) out.push({ text: json.slice(last) });
  return out;
}

function HighlightedJson({ value }: { value: unknown }) {
  const tokens = useMemo(() => tokenizeJson(JSON.stringify(value ?? null, null, 2)), [value]);
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
      {tokens.map((t, i) =>
        t.kind ? (
          <span key={i} className={JSON_TOKEN_CLASS[t.kind]}>
            {t.text}
          </span>
        ) : (
          <span key={i} className="text-muted-foreground">
            {t.text}
          </span>
        ),
      )}
    </pre>
  );
}

/** Header format dropdown. A non-`<button>` trigger, since it lives inside the
 *  ExpandableSection header button; the header wrapper stops the toggle click. */
function FormatSwitcher({
  format,
  onChange,
}: {
  format: IOFormat;
  onChange: (f: IOFormat) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          title="Change format"
          className="flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {FORMAT_LABEL[format]}
          <ChevronDown className="h-3 w-3" aria-hidden />
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-28 p-1">
        {FORMATS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => {
              onChange(f);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center rounded px-2 py-1 text-left text-[12px] transition-colors",
              f === format ? "bg-muted/70" : "hover:bg-muted/50",
            )}
          >
            {FORMAT_LABEL[f]}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function TraceIOSection({
  title,
  content,
  onCopy,
  loading = false,
  defaultOpen = true,
}: {
  title: string;
  content: string | null;
  onCopy?: () => void;
  loading?: boolean;
  defaultOpen?: boolean;
}) {
  const [format, setFormat] = useState<IOFormat>("pretty");
  const parsed = useMemo(() => (content ? parseMaybe(content) : null), [content]);
  const hasContent = content !== null && content !== "";

  return (
    <ExpandableSection
      title={title}
      defaultOpen={defaultOpen}
      onCopy={onCopy}
      headerAction={
        hasContent && !loading ? <FormatSwitcher format={format} onChange={setFormat} /> : undefined
      }
    >
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </div>
      ) : !hasContent ? (
        <span className="text-[11px] text-muted-foreground">-</span>
      ) : format === "pretty" ? (
        <ContentRenderer content={content} />
      ) : format === "markdown" ? (
        // Model output is very often markdown; render it rather than showing the raw source.
        <MarkdownView content={content} />
      ) : format === "json" ? (
        <HighlightedJson value={parsed} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {formatValue(parsed, format)}
        </pre>
      )}
    </ExpandableSection>
  );
}
