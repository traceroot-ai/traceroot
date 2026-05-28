"use client";

interface JsonRendererProps {
  value: unknown;
  depth?: number;
}

// Raster image data URIs only — image/svg+xml is excluded because data-URI SVG
// can execute embedded script (XSS).
const IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

// Base64-encoded magic-byte prefixes for raster image formats. Used to detect
// bare base64 (no data: prefix), e.g. OpenAI's image_generation_call.result.
const BASE64_IMAGE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["iVBORw0KGgo", "image/png"],
  ["/9j/", "image/jpeg"],
  ["R0lGOD", "image/gif"],
  ["UklGR", "image/webp"],
];

// Returns a renderable <img> src for inline base64 images, or null.
export function imageSrc(value: string): string | null {
  if (IMAGE_DATA_URI.test(value)) return value;
  if (value.length < 100) return null;
  const match = BASE64_IMAGE_PREFIXES.find(([prefix]) => value.startsWith(prefix));
  if (match && /^[A-Za-z0-9+/=]+$/.test(value)) {
    return `data:${match[1]};base64,${value}`;
  }
  return null;
}

export function InlineImage({ src }: { src: string }) {
  return (
    <img
      src={src}
      alt="Inline image"
      className="my-1 max-h-64 max-w-full rounded border border-border"
    />
  );
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
    // Render inline base64 images (data URIs and bare base64) as images.
    const src = imageSrc(value);
    if (src) {
      return <InlineImage src={src} />;
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
