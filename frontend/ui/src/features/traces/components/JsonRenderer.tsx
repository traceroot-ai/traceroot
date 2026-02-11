"use client";

interface JsonRendererProps {
  value: unknown;
  depth?: number;
}

/**
 * Recursive JSON renderer with syntax highlighting
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
    // Try to parse JSON strings and render them as structured objects
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed === "object" && parsed !== null) {
          return <JsonRenderer value={parsed} depth={depth} />;
        }
      } catch {
        // Not valid JSON, render as plain string
      }
    }
    return (
      <span className="whitespace-pre-wrap break-words text-green-700 dark:text-green-400">
        &quot;{value}&quot;
      </span>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">[]</span>;
    }

    return (
      <span>
        <span className="text-muted-foreground">[</span>
        <div className="ml-3">
          {value.map((item, index) => (
            <div key={index}>
              <JsonRenderer value={item} depth={depth + 1} />
              {index < value.length - 1 && <span className="text-muted-foreground">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">]</span>
      </span>
    );
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    if (keys.length === 0) {
      return <span className="text-muted-foreground">{"{}"}</span>;
    }

    return (
      <span>
        <span className="text-muted-foreground">{"{"}</span>
        <div className="ml-3">
          {keys.map((key, index) => (
            <div key={key}>
              <span className="text-sky-600 dark:text-sky-400">{key}</span>
              <span className="text-muted-foreground">: </span>
              <JsonRenderer value={(value as Record<string, unknown>)[key]} depth={depth + 1} />
              {index < keys.length - 1 && <span className="text-muted-foreground">,</span>}
            </div>
          ))}
        </div>
        <span className="text-muted-foreground">{"}"}</span>
      </span>
    );
  }

  return <span>{String(value)}</span>;
}
