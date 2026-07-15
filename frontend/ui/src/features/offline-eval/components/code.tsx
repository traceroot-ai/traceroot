"use client";

import * as React from "react";
import { ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Small code helpers for the datasets UI: a line-numbered editable field, and a
 * read-only value block that can be shown as YAML / text / JSON / pretty JSON
 * and minimised — the same shapes a trace value uses.
 */

export type ValueKind = "yaml" | "text" | "json" | "pretty";

const KIND_LABEL: Record<ValueKind, string> = {
  yaml: "YAML",
  text: "Text",
  json: "JSON",
  pretty: "Pretty",
};

const KINDS: ValueKind[] = ["yaml", "text", "json", "pretty"];

/** Minimal YAML for the flat values we hold. Empty → `null`, as requested. */
function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined || value === "") return `${pad}null`;
  if (typeof value === "string") {
    // Multi-line strings render as a block scalar; single lines inline.
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
    return value.map((item) => `${pad}- ${String(item)}`).join("\n");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `${pad}null`;
  return entries.map(([k, v]) => `${pad}${k}: ${String(v)}`).join("\n");
}

/** Formats a value for a given view kind. */
export function formatValue(value: unknown, kind: ValueKind): string {
  switch (kind) {
    case "text":
      if (value === null || value === undefined || value === "") return "null";
      return typeof value === "string" ? value : JSON.stringify(value);
    case "json":
      return JSON.stringify(value ?? null);
    case "pretty":
      return JSON.stringify(value ?? null, null, 2);
    case "yaml":
    default:
      return toYaml(value);
  }
}

/** Trace-panel JSON token colors, mirrored so JSON reads the same everywhere. */
const JSON_TOKEN_COLORS = {
  key: "text-sky-600 dark:text-sky-400",
  string: "text-green-700 dark:text-green-400",
  number: "text-blue-600 dark:text-blue-400",
  boolean: "text-purple-600 dark:text-purple-400",
  null: "text-orange-600 dark:text-orange-400",
  punctuation: "text-muted-foreground",
};

/**
 * Splits valid JSON text into colored tokens, preserving every character so the
 * result can sit exactly behind a textarea. Returns null when the text is empty
 * or not valid JSON, so the field shows as plain text mid-edit.
 */
function tokenizeJson(text: string): { text: string; cls: string }[] | null {
  if (text.trim() === "") return null;
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const tokens: { text: string; cls: string }[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      let k = j;
      while (k < n && /\s/.test(text[k])) k += 1;
      const isKey = text[k] === ":";
      tokens.push({
        text: text.slice(i, j),
        cls: isKey ? JSON_TOKEN_COLORS.key : JSON_TOKEN_COLORS.string,
      });
      i = j;
    } else if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(text[j])) j += 1;
      tokens.push({ text: text.slice(i, j), cls: JSON_TOKEN_COLORS.number });
      i = j;
    } else if (text.startsWith("true", i) || text.startsWith("false", i)) {
      const word = text.startsWith("true", i) ? "true" : "false";
      tokens.push({ text: word, cls: JSON_TOKEN_COLORS.boolean });
      i += word.length;
    } else if (text.startsWith("null", i)) {
      tokens.push({ text: "null", cls: JSON_TOKEN_COLORS.null });
      i += 4;
    } else if ("{}[],:".includes(c)) {
      tokens.push({ text: c, cls: JSON_TOKEN_COLORS.punctuation });
      i += 1;
    } else if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(text[j])) j += 1;
      tokens.push({ text: text.slice(i, j), cls: "" });
      i = j;
    } else {
      tokens.push({ text: c, cls: "" });
      i += 1;
    }
  }
  return tokens;
}

function Gutter({ count }: { count: number }) {
  return (
    <div
      aria-hidden
      className="select-none border-r border-border bg-muted/40 px-2 py-1.5 text-right font-mono text-[12px] leading-relaxed text-muted-foreground/50"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
  );
}

/** Splits whole-text JSON tokens into per-line arrays (newlines are consumed). */
function tokenizeJsonByLine(text: string): { text: string; cls: string }[][] | null {
  const tokens = tokenizeJson(text);
  if (!tokens) return null;
  const lines: { text: string; cls: string }[][] = [[]];
  for (const tok of tokens) {
    const parts = tok.text.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1].push({ text: part, cls: tok.cls });
    });
  }
  return lines;
}

/**
 * Editable code field with a line-number gutter on the left.
 *
 * A wrapping display layer (line numbers + optional JSON colors) sits under a
 * transparent-text textarea. Because both wrap with the same font/width, a long
 * line wraps onto the next visual row while keeping a single line number pinned
 * to its top — the way a real code editor renders wrapped lines. The box rests
 * at `minRows` (blank, unnumbered space below the content) and grows one line
 * per Enter.
 */
export function LineNumberedTextarea({
  value,
  onChange,
  minRows = 1,
  placeholder,
  highlightJson = false,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
  placeholder?: string;
  /** When true, JSON content is syntax-highlighted (trace-panel colors). */
  highlightJson?: boolean;
  "aria-label"?: string;
}) {
  // Keep a real trailing empty line so the last line is always clickable — click
  // it and type without pressing Enter first, and a 1-line value still shows an
  // empty line 2. The parent value never keeps that trailing newline: it's added
  // for display/editing and stripped from what onChange reports.
  const textValue = value.endsWith("\n") ? value : value + "\n";
  const rawLines = textValue.split("\n");
  const tokenLines = highlightJson ? tokenizeJsonByLine(textValue) : null;
  const totalLines = Math.max(rawLines.length, minRows);
  const digits = Math.max(2, String(totalLines).length);
  const gutterWidth = `calc(${digits}ch + 1rem)`;

  return (
    <div className="relative overflow-hidden rounded border border-input bg-background font-mono text-[12px] leading-relaxed focus-within:ring-1 focus-within:ring-ring">
      {/* Display layer — line numbers + (highlighted) content, wraps per line. */}
      <div aria-hidden className="pointer-events-none py-1.5">
        {Array.from({ length: totalLines }).map((_, i) => (
          <div key={i} className="flex items-start">
            <span
              className="shrink-0 select-none border-r border-border bg-muted/40 px-2 text-right text-muted-foreground/50"
              style={{ width: gutterWidth }}
            >
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2">
              {tokenLines
                ? (tokenLines[i] ?? []).map((t, ti) => (
                    <span key={ti} className={t.cls || undefined}>
                      {t.text}
                    </span>
                  ))
                : (rawLines[i] ?? "")}
              {"​"}
            </span>
          </div>
        ))}
      </div>
      {/* Editing layer — transparent text lined up over the display layer. */}
      <textarea
        value={textValue}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v.endsWith("\n") ? v.slice(0, -1) : v);
        }}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="absolute inset-0 resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent py-1.5 pr-2 font-mono text-[12px] leading-relaxed text-transparent caret-foreground placeholder:text-muted-foreground focus:outline-none"
        style={{ paddingLeft: `calc(${gutterWidth} + 0.5rem)` }}
      />
    </div>
  );
}

/** Read-only line-numbered code, used inside a ValueBlock. */
function CodeView({ text }: { text: string }) {
  const lines = text === "" ? 1 : text.split("\n").length;
  return (
    <div className="flex overflow-x-auto rounded border border-border bg-muted/20">
      <Gutter count={lines} />
      <pre className="flex-1 whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[12px] leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

/**
 * A labelled value that can switch view kind (YAML / Text / JSON / Pretty) and
 * be minimised — the controls sit on the right of the label.
 */
export function ValueBlock({
  label,
  value,
  defaultKind = "yaml",
}: {
  label: string;
  value: unknown;
  defaultKind?: ValueKind;
}) {
  const [kind, setKind] = React.useState<ValueKind>(defaultKind);
  const [menuOpen, setMenuOpen] = React.useState(false);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {KIND_LABEL[kind]}
              <ChevronDown className="h-3 w-3" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-28 p-1">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setKind(k);
                  setMenuOpen(false);
                }}
                className={cn(
                  "flex w-full items-center rounded px-2 py-1 text-left text-[12px] transition-colors",
                  k === kind ? "bg-muted/70" : "hover:bg-muted/50",
                )}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      <CodeView text={formatValue(value, kind)} />
    </div>
  );
}

/** Picks the initial format from the content: a JSON object/array → json, else text. */
function detectKind(text: string): ValueKind {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      /* looks like JSON but isn't — fall through to text */
    }
  }
  return "text";
}

/**
 * Editable counterpart to ValueBlock. The text is controlled by the caller;
 * switching the view kind reformats it best-effort (only when it parses as
 * JSON), so plain text is never mangled.
 *
 * Optional extras (all off by default, so existing callers are unchanged):
 * `copyable` adds a copy button, `enlargeable` adds a taller/shorter toggle,
 * `autoDetectKind` picks JSON vs text from the initial content, and `minRows`
 * sets the resting height.
 */
export function EditableValueBlock({
  label,
  text,
  onChange,
  defaultKind = "yaml",
  ariaLabel,
  copyable = false,
  enlargeable = false,
  autoDetectKind = false,
  minRows = 1,
  boxed = false,
}: {
  label: string;
  text: string;
  onChange: (text: string) => void;
  defaultKind?: ValueKind;
  ariaLabel?: string;
  copyable?: boolean;
  enlargeable?: boolean;
  autoDetectKind?: boolean;
  minRows?: number;
  /** Wrap the block in a bordered card with a muted header strip (like FormCard). */
  boxed?: boolean;
}) {
  const [kind, setKind] = React.useState<ValueKind>(defaultKind);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [enlarged, setEnlarged] = React.useState(false);
  const userSetKind = React.useRef(false);
  const detected = React.useRef(false);

  // Detect JSON vs text once, when the value first arrives (e.g. after a dialog
  // seeds it), unless the user has already chosen a format from the switcher.
  React.useEffect(() => {
    if (autoDetectKind && !userSetKind.current && !detected.current && text.trim() !== "") {
      detected.current = true;
      setKind(detectKind(text));
    }
  }, [autoDetectKind, text]);

  const changeKind = (next: ValueKind) => {
    userSetKind.current = true;
    setKind(next);
    setMenuOpen(false);
    // Reformat only when the current text is valid JSON; otherwise leave it be.
    try {
      const parsed = JSON.parse(text);
      onChange(formatValue(parsed, next));
    } catch {
      /* not JSON — keep the text as typed */
    }
  };

  // Rest at minRows and grow one line at a time with the content; enlarge opens
  // it fully.
  const effectiveMin = enlarged ? Math.max(minRows, 24) : minRows;

  const controls = (
    <div className="flex items-center gap-0.5">
      {enlargeable && (
        <button
          type="button"
          onClick={() => setEnlarged((v) => !v)}
          title={enlarged ? "Shrink" : "Enlarge"}
          aria-label={enlarged ? "Shrink field" : "Enlarge field"}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {enlarged ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      )}
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {KIND_LABEL[kind]}
            <ChevronDown className="h-3 w-3" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-28 p-1">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => changeKind(k)}
              className={cn(
                "flex w-full items-center rounded px-2 py-1 text-left text-[12px] transition-colors",
                k === kind ? "bg-muted/70" : "hover:bg-muted/50",
              )}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </PopoverContent>
      </Popover>
      {copyable && (
        <CopyButton
          value={text}
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          title="Copy"
        />
      )}
    </div>
  );

  const field = (
    <LineNumberedTextarea
      value={text}
      onChange={onChange}
      minRows={effectiveMin}
      highlightJson={kind === "json" || kind === "pretty"}
      aria-label={ariaLabel ?? label}
    />
  );

  if (boxed) {
    return (
      <div className="border border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
          <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
          {controls}
        </div>
        <div className="p-3">{field}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        {controls}
      </div>
      {field}
    </div>
  );
}
