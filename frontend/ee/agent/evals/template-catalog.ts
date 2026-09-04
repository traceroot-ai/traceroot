import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Reads the canonical detector prompts out of the UI-owned template catalog.
 *
 * The catalog is a plain TypeScript module in the Next app that this package
 * does not depend on (and whose own imports use the app's `@/` alias), so it
 * is parsed from source rather than imported — the same approach the system
 * prompt's catalog-drift guard already takes.
 */
const CATALOG_PATH = fileURLToPath(
  new URL("../../../ui/src/features/detectors/templates.ts", import.meta.url),
);

export function loadCatalogSource(): string {
  return readFileSync(CATALOG_PATH, "utf8");
}

// The single-character escapes a source literal can spell out. Anything else
// after a backslash stands for itself (`\\`, `\"`, `\'`, a backtick, `\$`),
// which is what JS itself does with an unrecognized escape.
const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  b: "\b",
  f: "\f",
  v: "\v",
  0: "\0",
};

/**
 * Read a quoted literal up to its closing quote, decoding escapes.
 *
 * The stored prompt holds the DECODED text, so a source literal spelling a
 * newline as `\n` has to come back as a newline — copying the escape through
 * verbatim would make the comparison against the stored prompt fail for every
 * template whose canonical text is written with escapes.
 */
function readLiteral(source: string, quote: string, templateId: string): string {
  let value = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\\") {
      const escaped = source[i + 1] ?? "";
      const hex = escaped === "u" ? source.slice(i + 2, i + 6) : "";
      if (hex.length === 4 && /^[0-9a-fA-F]{4}$/.test(hex)) {
        value += String.fromCharCode(parseInt(hex, 16));
        i += 5;
        continue;
      }
      value += ESCAPES[escaped] ?? escaped;
      i += 1;
      continue;
    }
    if (char === quote) return value;
    value += char;
  }
  throw new Error(`detector template "${templateId}" has an unterminated prompt literal`);
}

// The next catalog entry's id field, anchored to the start of its own line.
// Catalog entries are formatted one field per line, so an unanchored search
// would also match `id: "` appearing inside a prompt's own text and cut the
// entry short there.
const NEXT_ENTRY_RE = /^[ \t]*id: "/m;

/**
 * Pull one template's `prompt` text out of the catalog source.
 *
 * The search is bounded by the next entry's `id:` so a template whose own
 * prompt is missing cannot silently borrow the following entry's.
 */
export function extractTemplatePrompt(source: string, templateId: string): string {
  const marker = `id: "${templateId}",`;
  const start = source.indexOf(marker);
  if (start === -1) {
    throw new Error(`detector template catalog has no entry with id "${templateId}"`);
  }

  const rest = source.slice(start + marker.length);
  const nextEntry = rest.search(NEXT_ENTRY_RE);
  const entry = nextEntry === -1 ? rest : rest.slice(0, nextEntry);

  const promptAt = entry.indexOf("prompt:");
  if (promptAt === -1) {
    throw new Error(`detector template "${templateId}" has no prompt field`);
  }

  const literal = entry.slice(promptAt + "prompt:".length).trimStart();
  const quote = literal[0];
  if (quote !== "`" && quote !== '"') {
    throw new Error(`detector template "${templateId}" has an unreadable prompt literal`);
  }

  const value = readLiteral(literal.slice(1), quote, templateId);
  if (quote === "`" && value.includes("${")) {
    // An interpolated prompt cannot be resolved from source alone, and the
    // stored text would not match it — fail loudly rather than mis-assert.
    throw new Error(`detector template "${templateId}" interpolates its prompt`);
  }
  return value;
}

/** A memoized `templateId -> canonical prompt` lookup over the real catalog. */
export function makeCanonicalPrompt(): (templateId: string) => string {
  let source: string | undefined;
  const cache = new Map<string, string>();

  return (templateId: string): string => {
    const cached = cache.get(templateId);
    if (cached !== undefined) return cached;

    source ??= loadCatalogSource();
    const prompt = extractTemplatePrompt(source, templateId);
    cache.set(templateId, prompt);
    return prompt;
  };
}
