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

/** Read a quoted literal, honoring backslash escapes, up to its closing quote. */
function readLiteral(source: string, quote: string, templateId: string): string {
  let value = "";
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    if (char === "\\") {
      value += source[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (char === quote) return value;
    value += char;
  }
  throw new Error(`detector template "${templateId}" has an unterminated prompt literal`);
}

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
  const nextEntry = rest.indexOf('id: "');
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
