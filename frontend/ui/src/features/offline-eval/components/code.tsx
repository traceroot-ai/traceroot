"use client";

import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MarkdownView } from "@/components/ui/markdown-view";
import { cn } from "@/lib/utils";

/**
 * Small code helpers for the datasets UI: a line-numbered editable field, and a
 * read-only value block that can be shown as YAML / text / JSON / pretty JSON
 * and minimised — the same shapes a trace value uses.
 */

export type ValueKind = "yaml" | "text" | "json" | "pretty" | "markdown";

const KIND_LABEL: Record<ValueKind, string> = {
  yaml: "YAML",
  text: "Text",
  json: "JSON",
  pretty: "Pretty",
  markdown: "Markdown",
};

const KINDS: ValueKind[] = ["yaml", "text", "json", "pretty", "markdown"];

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
    // Markdown is a *rendering* of the raw text, so it carries the value through
    // verbatim (an empty value stays empty rather than becoming the string "null").
    case "markdown":
      if (value === null || value === undefined) return "";
      return typeof value === "string" ? value : JSON.stringify(value);
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
  readOnly = false,
  collapsed = false,
  collapseAt = 500,
  onExpand,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
  placeholder?: string;
  /** When true, JSON content is syntax-highlighted (trace-panel colors). */
  highlightJson?: boolean;
  /** Display only — selectable and syntax-coloured, but not editable. */
  readOnly?: boolean;
  /** Clip a long value to `collapseAt` chars and show an inline "…expand" as the
   *  last line INSIDE the box (like the span-detail I/O). Editing is suspended while
   *  collapsed — the transparent textarea isn't mounted — so the inline control is
   *  clickable. Expanding is the caller's to handle via `onExpand`. */
  collapsed?: boolean;
  collapseAt?: number;
  onExpand?: () => void;
  "aria-label"?: string;
}) {
  const isCollapsed = collapsed && value.length > collapseAt;
  const shown = isCollapsed ? value.slice(0, collapseAt) : value;
  // Keep a real trailing empty line so the last line is always clickable — click
  // it and type without pressing Enter first, and a 1-line value still shows an
  // empty line 2. The parent value never keeps that trailing newline: it's added
  // for display/editing and stripped from what onChange reports. (When collapsed
  // there's no editing, so no trailing line is needed.)
  //
  // The newline is appended *unconditionally*. Appending it only when the value
  // didn't already end in one meant pressing Enter (which makes the value end in
  // a newline) was cancelled out by the strip below, so the line count — and the
  // box height — never grew.
  const textValue = isCollapsed ? shown : `${value}\n`;
  const rawLines = textValue.split("\n");
  const tokenLines = highlightJson ? tokenizeJsonByLine(textValue) : null;
  const totalLines = Math.max(rawLines.length, minRows);
  const digits = Math.max(2, String(totalLines).length);
  const gutterWidth = `calc(${digits}ch + 1rem)`;

  return (
    // The line-height is pinned to a whole pixel on BOTH layers. A fractional
    // line-height (e.g. leading-relaxed → 17.875px at 11px) is rounded per block
    // box in the display layer but flows continuously in the textarea, so the two
    // drift apart as lines accumulate and the textarea's last line gets clipped.
    <div className="relative overflow-hidden rounded border border-input bg-background font-mono text-[11px] leading-[18px] focus-within:ring-1 focus-within:ring-ring">
      {/* Display layer — line numbers + (highlighted) content, wraps per line.
          Collapsed has no textarea overlay, so it must take pointer events (the
          inline expand control lives here). */}
      <div
        aria-hidden={!isCollapsed}
        className={cn("pb-2 pt-1.5", !isCollapsed && "pointer-events-none")}
      >
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
        {/* Inline "…expand" as the final line, sitting with the text inside the box. */}
        {isCollapsed && (
          <div className="flex items-start">
            <span
              aria-hidden
              className="shrink-0 select-none border-r border-border bg-muted/40 px-2 text-right text-muted-foreground/50"
              style={{ width: gutterWidth }}
            >
              {"​"}
            </span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2">
              <button
                type="button"
                onClick={onExpand}
                className="cursor-pointer align-baseline text-muted-foreground hover:text-foreground"
              >
                …expand ({(value.length - collapseAt).toLocaleString()} more characters)
              </button>
            </span>
          </div>
        )}
      </div>
      {/* Editing layer — transparent text lined up over the display layer. Omitted
          while collapsed so the inline expand control above stays clickable. */}
      {!isCollapsed && (
        <textarea
          value={textValue}
          onChange={(e) => {
            if (readOnly) return;
            const v = e.target.value;
            onChange(v.endsWith("\n") ? v.slice(0, -1) : v);
          }}
          readOnly={readOnly}
          spellCheck={false}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn(
            // Must match the display layer's font metrics exactly — the two are
            // overlaid, so the line-height is the same whole pixel value.
            "absolute inset-0 resize-none overflow-hidden whitespace-pre-wrap break-words bg-transparent pb-2 pr-2 pt-1.5 font-mono text-[11px] leading-[18px] text-transparent placeholder:text-muted-foreground focus:outline-none",
            readOnly ? "cursor-default caret-transparent" : "caret-foreground",
          )}
          style={{ paddingLeft: `calc(${gutterWidth} + 0.5rem)` }}
        />
      )}
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
      {kind === "markdown" ? (
        <div className="rounded border border-input bg-background px-2 py-1.5">
          <MarkdownView content={formatValue(value, kind)} />
        </div>
      ) : (
        <CodeView text={formatValue(value, kind)} />
      )}
    </div>
  );
}

/** Picks the initial format from the content: a JSON object/array → json, else text. */
function detectKind(text: string): ValueKind {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      // Already pretty-printed (multi-line) JSON should read as "Pretty", not
      // "JSON" — otherwise the mode label contradicts the indented content.
      return trimmed.includes("\n") ? "pretty" : "json";
    } catch {
      /* looks like JSON but isn't — fall through to text */
    }
  }
  return "text";
}

/** Longest single-line JSON that still reads well inline. */
const COMPACT_MAX_CHARS = 100;

/** True when no member is itself an object/array, so one line stays readable. */
function isFlat(value: unknown): boolean {
  const members = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.values(value as Record<string, unknown>)
      : [];
  return members.every((v) => v === null || typeof v !== "object");
}

/** How a field wants a JSON value presented when it is first seeded. */
export type SeedJsonPreference = "expanded" | "compact";

/**
 * The format a freshly-captured value should be shown (and stored) in.
 *
 * Without this, the mode is whatever the instrumented app happened to emit —
 * the same logical value reads as Pretty or compact depending on whether
 * upstream used an indent. Seeding makes it a property of the FIELD instead:
 * values you read and edit closely (input, recorded output) expand; incidental
 * ones (metadata) stay on one line.
 *
 * `compact` is honoured only while the value actually fits on a line — a large
 * or nested value falls back to Pretty, since a one-liner is only better while
 * it stays one line. Non-JSON text is returned untouched (never mangled).
 */
export function seedFormat(
  text: string,
  prefer: SeedJsonPreference,
): { kind: ValueKind; text: string } {
  const trimmed = text.trim();
  if (trimmed === "" || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return { kind: "text", text };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "text", text }; // looks like JSON but isn't
  }
  if (prefer === "compact") {
    const compact = formatValue(parsed, "json");
    if (compact.length <= COMPACT_MAX_CHARS && isFlat(parsed)) {
      return { kind: "json", text: compact };
    }
  }
  return { kind: "pretty", text: formatValue(parsed, "pretty") };
}

/**
 * Editable counterpart to ValueBlock. The text is controlled by the caller;
 * switching the view kind reformats it best-effort (only when it parses as
 * JSON), so plain text is never mangled.
 *
 * Optional extras (all off by default, so existing callers are unchanged):
 * `copyable` adds a copy button, `autoDetectKind` picks JSON vs text from the
 * initial content, and `minRows` sets the resting height.
 */
/** A long value collapses behind an in-field "…expand" control past this length. */
const COLLAPSE_AT = 500;

export function EditableValueBlock({
  label,
  text,
  onChange,
  defaultKind = "yaml",
  ariaLabel,
  copyable = false,
  autoDetectKind = false,
  seedJson,
  minRows = 1,
  boxed = false,
  readOnly = false,
  collapsible = false,
  collapseResetKey,
}: {
  label: string;
  text: string;
  onChange: (text: string) => void;
  defaultKind?: ValueKind;
  ariaLabel?: string;
  copyable?: boolean;
  autoDetectKind?: boolean;
  /**
   * Present (and normalise) a seeded JSON value per this field's role rather
   * than following however it was serialised upstream. Supersedes
   * `autoDetectKind`. See `seedFormat`.
   */
  seedJson?: SeedJsonPreference;
  minRows?: number;
  /** Wrap the block in a bordered card with a muted header strip (like FormCard). */
  boxed?: boolean;
  /** Display only — same look and format switcher, but the text can't be edited. */
  readOnly?: boolean;
  /** Cap a long value behind an in-field "…expand (N more)" control that sits below
   *  the header and clips only the value body (not the whole card). Off by default. */
  collapsible?: boolean;
  /** Re-collapse when this changes (e.g. the source span switched). Editing never
   *  re-collapses — only a new key does. Unneeded when the block is remounted by `key`. */
  collapseResetKey?: string;
}) {
  const [kind, setKind] = React.useState<ValueKind>(defaultKind);
  const [menuOpen, setMenuOpen] = React.useState(false);
  // Minimised via the header chevron, like the span detail panel's I/O sections.
  const [open, setOpen] = React.useState(true);
  // A long value is clipped behind an in-field "…expand" control; reset on key change.
  const [fieldExpanded, setFieldExpanded] = React.useState(false);
  React.useEffect(() => {
    setFieldExpanded(false);
  }, [collapseResetKey]);
  const userSetKind = React.useRef(false);
  // Read-only fields reformat locally (the parent value never changes), so the
  // format switcher still works without touching the source of truth.
  const [display, setDisplay] = React.useState(text);
  React.useEffect(() => {
    if (readOnly) setDisplay(text);
  }, [readOnly, text]);

  // Pick the format whenever a new value is seeded (e.g. navigating between cases
  // re-seeds this field), unless the user has pinned one from the switcher.
  // `seedJson` chooses by FIELD ROLE and normalises the text once so the stored
  // value is canonical; `autoDetectKind` just follows the content. setKind is a
  // no-op when unchanged, and the text guard stops the normalise from looping.
  React.useEffect(() => {
    if (userSetKind.current || text.trim() === "") return;
    if (seedJson) {
      const seeded = seedFormat(text, seedJson);
      setKind(seeded.kind);
      if (seeded.text !== text) {
        if (readOnly) setDisplay(seeded.text);
        else onChange(seeded.text);
      }
      return;
    }
    if (autoDetectKind) setKind(detectKind(text));
  }, [autoDetectKind, seedJson, text, readOnly, onChange]);

  const changeKind = (next: ValueKind) => {
    userSetKind.current = true;
    setKind(next);
    setMenuOpen(false);
    // Markdown renders the text as-is rather than re-serializing it, so switching
    // to it must never rewrite the stored value.
    if (next === "markdown") return;
    // Reformat only when the current text is valid JSON; otherwise leave it be.
    try {
      const parsed = JSON.parse(readOnly ? display : text);
      const formatted = formatValue(parsed, next);
      if (readOnly) setDisplay(formatted);
      else onChange(formatted);
    } catch {
      /* not JSON — keep the text as typed */
    }
  };

  const controls = (
    <div className="flex items-center gap-1">
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
        // Sized to the read-only I/O section's copy affordance (16px box, 12px
        // icon) so the header strip is the same height as ExpandableSection's.
        <CopyButton
          value={readOnly ? display : text}
          className="h-4 w-4 text-muted-foreground hover:text-foreground"
          iconClassName="h-3 w-3"
          title="Copy"
        />
      )}
    </div>
  );

  // A long value clips to an in-field "…expand" control that sits INSIDE the code
  // block, inline with the text (like the span-detail I/O renderer) — not a button
  // below the card. Expand-only; re-collapses when `collapseResetKey` changes.
  const collapseValue = readOnly ? display : text;
  const isCollapsed = collapsible && collapseValue.length > COLLAPSE_AT && !fieldExpanded;

  // Markdown is a rendered preview of the text, so it replaces the editable field;
  // switching back to any other format returns to editing the same raw value.
  const field =
    kind === "markdown" ? (
      <div>
        <div className="rounded border border-input bg-background px-2 py-1.5">
          {isCollapsed ? (
            <div>
              <div className="max-h-40 overflow-hidden">
                <MarkdownView content={readOnly ? display : text} />
              </div>
              <button
                type="button"
                onClick={() => setFieldExpanded(true)}
                className="mt-1 cursor-pointer text-[11px] text-muted-foreground hover:text-foreground"
              >
                …expand ({(collapseValue.length - COLLAPSE_AT).toLocaleString()} more characters)
              </button>
            </div>
          ) : (
            <MarkdownView content={readOnly ? display : text} />
          )}
        </div>
        {!readOnly && (
          <p className="mt-1 text-[10px] text-muted-foreground">
            Preview — switch to Text to edit.
          </p>
        )}
      </div>
    ) : (
      <LineNumberedTextarea
        value={readOnly ? display : text}
        onChange={onChange}
        minRows={minRows}
        highlightJson={kind === "json" || kind === "pretty"}
        readOnly={readOnly}
        collapsed={isCollapsed}
        collapseAt={COLLAPSE_AT}
        onExpand={() => setFieldExpanded(true)}
        aria-label={ariaLabel ?? label}
      />
    );

  // Chevron + label: the whole thing toggles, matching the span detail panel.
  const heading = (size: "sm" | "xs") => (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className={cn(
        "flex items-center gap-1.5 rounded font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Boxed matches the span detail panel's read-only I/O sections
        // (ExpandableSection): foreground label, muted chevron. The inline
        // variant keeps its lighter form-label look.
        size === "sm"
          ? "text-xs text-foreground"
          : "text-[11px] text-muted-foreground hover:text-foreground",
      )}
    >
      {open ? (
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0", size === "sm" && "text-muted-foreground")}
          aria-hidden
        />
      ) : (
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0", size === "sm" && "text-muted-foreground")}
          aria-hidden
        />
      )}
      {label}
    </button>
  );

  // Boxed chrome mirrors ExpandableSection (the read-only span I/O sections) so an
  // editable Input/Output/Metadata field sits beside them without a style seam.
  if (boxed) {
    return (
      // `shrink-0` is required, not cosmetic: these fields stack in flex-column
      // scroll panes (the dataset case panel, the Save-as-test-case drawer), and
      // the `overflow-hidden` below sets the flex item's automatic min-size to 0 —
      // so without it the flex column shrinks the field to fit and clips its
      // content instead of letting the pane scroll.
      <div className="shrink-0 overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-2.5 py-1.5">
          {heading("sm")}
          {controls}
        </div>
        {open && <div className="bg-background px-2.5 py-2">{field}</div>}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        {heading("xs")}
        {controls}
      </div>
      {open && field}
    </div>
  );
}
