import type { TraceListItem } from "@/types/api";

/** The whole `traceroot.` namespace is ours, not the user's; storage strips it too. */
const INTERNAL_METADATA_PREFIX = "traceroot.";

export interface MetadataEntry {
  key: string;
  /** Display text. Structured values are rendered as JSON and are not filterable. */
  value: string;
  /** The value as parsed, so round-tripping to JSON reproduces the source exactly. */
  rawValue: unknown;
  isFilterable: boolean;
}

type MetadataSource = string | Record<string, unknown> | null | undefined;

// Only a string is the stored text verbatim. Re-serializing a structured value here produces
// text that will not match what is stored, so it renders readably but is not filterable.
function displayMetadataValue(value: unknown): { value: string; isFilterable: boolean } {
  if (typeof value === "string") return { value, isFilterable: true };
  try {
    const serialized = JSON.stringify(value);
    return { value: serialized ?? "", isFilterable: false };
  } catch {
    return { value: String(value), isFilterable: false };
  }
}

export function parseMetadataEntries(source: MetadataSource): MetadataEntry[] {
  if (!source) return [];
  let parsed: unknown = source;
  if (typeof source === "string") {
    try {
      parsed = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  return Object.entries(parsed as Record<string, unknown>)
    .filter(([key]) => !key.startsWith(INTERNAL_METADATA_PREFIX))
    .map(([key, value]) => ({ key, rawValue: value, ...displayMetadataValue(value) }));
}

export function unstructuredMetadataText(source: MetadataSource): string | null {
  if (typeof source !== "string" || source.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? null : source;
  } catch {
    return source;
  }
}

// Serializes rawValue, not the display text: a number displays as "0.9" but must copy back
// as 0.9, and stringifying the display text would quote every value in the document.
export function stringifyMetadataEntries(entries: readonly MetadataEntry[]): string {
  return JSON.stringify(Object.fromEntries(entries.map((e) => [e.key, e.rawValue])), null, 2);
}

export function traceMetadataEntries(trace: TraceListItem): MetadataEntry[] {
  return parseMetadataEntries(trace.metadata_map);
}
