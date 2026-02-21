"use client";

import { useMemo, useState } from "react";
import { Copy, Check, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

function tryParseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

/** Deep-parse JSON strings recursively */
function deepParseJson(value: unknown, depth: number = 0): unknown {
  if (depth > 3) return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return deepParseJson(parsed, depth + 1);
    } catch {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map((item) => deepParseJson(item, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = deepParseJson(v, depth + 1);
    }
    return result;
  }

  return value;
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-orange-500 dark:text-orange-400">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-purple-600 dark:text-purple-400">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="text-blue-600 dark:text-blue-400">{value}</span>;
  }
  if (typeof value === "string") {
    const display = value.length > 300 ? value.slice(0, 300) + "\u2026" : value;
    return (
      <span className="break-words text-green-700 dark:text-green-400">&quot;{display}&quot;</span>
    );
  }
  return <span>{String(value)}</span>;
}

function TreeNode({
  keyName,
  value,
  depth = 0,
  collapseAfter = 2,
}: {
  keyName?: string;
  value: unknown;
  depth?: number;
  collapseAfter?: number;
}) {
  const isExpandable = typeof value === "object" && value !== null;
  const [collapsed, setCollapsed] = useState(isExpandable && depth >= collapseAfter);

  if (!isExpandable) {
    return (
      <div className="py-px" style={{ paddingLeft: depth * 16 }}>
        {keyName !== undefined && <span className="text-muted-foreground">{keyName}: </span>}
        <PrimitiveValue value={value} />
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  const sizeLabel = Array.isArray(value) ? `Array(${entries.length})` : `{${entries.length} keys}`;

  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <div
        className="flex cursor-pointer items-center gap-1 rounded py-px hover:bg-muted/50"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? (
          <ChevronRight className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        {keyName !== undefined && <span className="text-muted-foreground">{keyName}</span>}
        {collapsed && (
          <span className="ml-1 text-[10px] text-muted-foreground/60">{sizeLabel}</span>
        )}
      </div>
      {!collapsed &&
        entries.map(([k, v]) => (
          <TreeNode key={k} keyName={k} value={v} depth={depth + 1} collapseAfter={collapseAfter} />
        ))}
    </div>
  );
}

interface JsonViewProps {
  value: unknown;
  collapsed?: boolean | number;
  className?: string;
}

export function JsonView({ value, collapsed = 2, className }: JsonViewProps) {
  const parsed = useMemo(() => deepParseJson(value), [value]);
  const collapseAfter = typeof collapsed === "number" ? collapsed : collapsed ? 1 : 999;

  if (typeof parsed !== "object" || parsed === null) {
    return (
      <div className={cn("overflow-auto font-mono text-[12px]", className)}>
        <PrimitiveValue value={parsed} />
      </div>
    );
  }

  const entries = Array.isArray(parsed)
    ? parsed.map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(parsed as Record<string, unknown>);

  return (
    <div className={cn("overflow-auto font-mono text-[12px]", className)}>
      {entries.map(([k, v]) => (
        <TreeNode key={k} keyName={k} value={v} depth={0} collapseAfter={collapseAfter} />
      ))}
    </div>
  );
}

interface IOSectionProps {
  label: string;
  value: string | null;
}

export function IOSection({ label, value }: IOSectionProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const parsed = useMemo(() => (value ? deepParseJson(tryParseJson(value)) : null), [value]);

  if (!value) return null;

  const isJsonObject = typeof parsed === "object" && parsed !== null;
  const isSimpleString = typeof parsed === "string";

  const handleCopy = () => {
    const text = isJsonObject ? JSON.stringify(parsed, null, 2) : String(parsed);
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="overflow-hidden rounded-md border border-border bg-muted/30">
      {/* Section header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-1.5">
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {label}
        </button>
        <button
          onClick={handleCopy}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          title="Copy"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>

      {/* Content */}
      {!isCollapsed && (
        <div className="px-3 py-2">
          {isSimpleString ? (
            <div className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground">
              {parsed as string}
            </div>
          ) : isJsonObject ? (
            <JsonView value={parsed} collapsed={2} />
          ) : (
            <div className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-foreground">
              {String(parsed)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
