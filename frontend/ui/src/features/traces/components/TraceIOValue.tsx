"use client";

import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ContentRenderer } from "./ContentRenderer";

/**
 * Read-only span I/O / metadata value with a format switcher — Pretty (the smart
 * JSON tree / media renderer, the default), JSON (compact), Text (raw), and YAML.
 * The value is parsed as JSON when possible; a non-JSON string is shown as-is.
 */
type IOFormat = "pretty" | "json" | "text" | "yaml";

const FORMAT_LABEL: Record<IOFormat, string> = {
  pretty: "Pretty",
  json: "JSON",
  text: "Text",
  yaml: "YAML",
};
const FORMATS: IOFormat[] = ["pretty", "json", "text", "yaml"];

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

function formatValue(value: unknown, format: Exclude<IOFormat, "pretty">): string {
  switch (format) {
    case "json":
      return JSON.stringify(value ?? null);
    case "text":
      return toText(value);
    case "yaml":
      return toYaml(value);
  }
}

export function TraceIOValue({ content }: { content: string | null }) {
  const [format, setFormat] = useState<IOFormat>("pretty");
  const [menuOpen, setMenuOpen] = useState(false);
  const parsed = useMemo(() => (content ? parseMaybe(content) : null), [content]);

  if (content === null || content === "") {
    return <span className="text-[11px] text-muted-foreground">-</span>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-end">
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-0.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              title="Change format"
            >
              {FORMAT_LABEL[format]}
              <ChevronDown className="h-3 w-3" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-28 p-1">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => {
                  setFormat(f);
                  setMenuOpen(false);
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
      </div>
      {format === "pretty" ? (
        <ContentRenderer content={content} />
      ) : (
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
          {formatValue(parsed, format)}
        </pre>
      )}
    </div>
  );
}
