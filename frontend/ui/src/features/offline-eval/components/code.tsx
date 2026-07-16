"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
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

/**
 * Editable code field with a line-number gutter on the left. An empty value is
 * a single line "1" with an empty body. Grows with the content (no scroll sync
 * to keep the numbers aligned).
 */
export function LineNumberedTextarea({
  value,
  onChange,
  minRows = 1,
  placeholder,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
  placeholder?: string;
  "aria-label"?: string;
}) {
  const lines = Math.max(value === "" ? 1 : value.split("\n").length, minRows);
  return (
    <div className="flex overflow-hidden rounded border border-input bg-background focus-within:ring-1 focus-within:ring-ring">
      <Gutter count={lines} />
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={lines}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="flex-1 resize-none bg-transparent px-2 py-1.5 font-mono text-[12px] leading-relaxed placeholder:text-muted-foreground focus:outline-none"
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
