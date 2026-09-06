import { describe, it, expect } from "vitest";
import type { TraceListItem } from "@/types/api";
import {
  parseMetadataEntries,
  stringifyMetadataEntries,
  traceMetadataEntries,
  unstructuredMetadataText,
} from "./metadata";

// Minimal list row — only the metadata carrier matters here. The list payload carries
// `metadata_map`, the map the list query selects, not the legacy `metadata` JSON blob.
function makeTrace(metadataMap: Record<string, string>): TraceListItem {
  return {
    trace_id: "t-1",
    project_id: "p-1",
    name: "run",
    trace_start_time: "2026-06-01T00:00:00.000Z",
    user_id: null,
    session_id: null,
    span_count: 1,
    duration_ms: 10,
    error_count: 0,
    input: null,
    output: null,
    metadata_map: metadataMap,
  };
}

/** A displayed row whose value is the stored text, so clicking it can filter. */
const filterable = (key: string, value: string) => ({
  key,
  value,
  rawValue: value,
  isFilterable: true,
});
/** A displayed row rendered by us rather than read from storage: shown, not clickable. `raw`
 * is the value as parsed, which is what a copy of the document must reproduce. */
const displayOnly = (key: string, value: string, raw: unknown) => ({
  key,
  value,
  rawValue: raw,
  isFilterable: false,
});

describe("parseMetadataEntries", () => {
  it("turns a JSON object blob into key/value rows in payload order", () => {
    const entries = parseMetadataEntries('{"session_id":"s-1","tenant":"acme"}');
    expect(entries).toEqual([filterable("session_id", "s-1"), filterable("tenant", "acme")]);
  });

  it("accepts an already-parsed map as well as a blob", () => {
    expect(parseMetadataEntries({ session_id: "s-1" })).toEqual([filterable("session_id", "s-1")]);
  });

  it("strips traceroot's internal span keys", () => {
    const entries = parseMetadataEntries(
      '{"traceroot.span.id":"abc","traceroot.span.parent":"def","session_id":"s-1"}',
    );
    expect(entries).toEqual([filterable("session_id", "s-1")]);
  });

  it("strips every traceroot key, not only the span ones", () => {
    // SDK identity rides on nearly every span, so leaving it in would put two keys
    // nobody filters on above every real one in a frequency-ordered list.
    const entries = parseMetadataEntries(
      '{"traceroot.sdk.name":"python","traceroot.sdk.version":"0.1.0","service":"api"}',
    );
    expect(entries).toEqual([filterable("service", "api")]);
  });

  it("keeps a user key that merely mentions traceroot without the namespace prefix", () => {
    expect(parseMetadataEntries('{"my.traceroot.note":"keep","traceroot":"keep"}')).toEqual([
      filterable("my.traceroot.note", "keep"),
      filterable("traceroot", "keep"),
    ]);
  });

  // INVARIANT: a filterable row renders the text storage holds, because a click builds an
  // exact-match filter against the stored `metadata_map` value — the two spellings must agree
  // byte-for-byte or the filter silently matches nothing. A string value IS that text, so
  // re-quoting it, escaping it to unicode sequences, or rewriting separators inside it would
  // each build a filter for text storage never held.
  it.each([
    ['{"note": "a, b: c"}', [filterable("note", "a, b: c")]],
    [
      '{"city": "café", "note": "naïve — 東京"}',
      [filterable("city", "café"), filterable("note", "naïve — 東京")],
    ],
    [
      '{"note": "a { b", "tpl": "{\\"k\\": 1}"}',
      [filterable("note", "a { b"), filterable("tpl", '{"k": 1}')],
    ],
  ])("passes a string value through verbatim: %s", (source, expected) => {
    expect(parseMetadataEntries(source)).toEqual(expected);
  });

  it("renders a non-string scalar readably but does not offer it as a filter", () => {
    // The stored spelling of a non-string value is the server's, not this one's, so the
    // row shows the value and withholds the click rather than guessing.
    expect(parseMetadataEntries('{"n":3,"ok":true,"nothing":null}')).toEqual([
      displayOnly("n", "3", 3),
      displayOnly("ok", "true", true),
      displayOnly("nothing", "null", null),
    ]);
  });

  it("renders a structured value readably but does not offer it as a filter", () => {
    expect(parseMetadataEntries('{"nested": {"x": 1}, "many": ["a", "b"]}')).toEqual([
      displayOnly("nested", '{"x":1}', { x: 1 }),
      displayOnly("many", '["a","b"]', ["a", "b"]),
    ]);
  });

  it("renders an empty object and an empty array as themselves", () => {
    expect(parseMetadataEntries('{"nothing": {}, "none": []}')).toEqual([
      displayOnly("nothing", "{}", {}),
      displayOnly("none", "[]", []),
    ]);
  });

  it("yields no entries for absent, malformed, or non-object metadata", () => {
    expect(parseMetadataEntries(null)).toEqual([]);
    expect(parseMetadataEntries(undefined)).toEqual([]);
    expect(parseMetadataEntries("not json")).toEqual([]);
    expect(parseMetadataEntries("[1,2]")).toEqual([]);
    expect(parseMetadataEntries('"a string"')).toEqual([]);
  });
});

describe("unstructuredMetadataText", () => {
  it("returns the verbatim text of a blob that is not a JSON object", () => {
    expect(unstructuredMetadataText("plain note")).toBe("plain note");
    expect(unstructuredMetadataText("[1,2]")).toBe("[1,2]");
  });

  it("returns null for a structured object, so it renders as rows instead", () => {
    expect(unstructuredMetadataText('{"a":"b"}')).toBeNull();
  });

  it("returns null for absent or blank metadata", () => {
    expect(unstructuredMetadataText(null)).toBeNull();
    expect(unstructuredMetadataText("   ")).toBeNull();
  });
});

describe("stringifyMetadataEntries", () => {
  it("re-serializes the displayed rows as pretty JSON", () => {
    expect(stringifyMetadataEntries([filterable("a", "b")])).toBe('{\n  "a": "b"\n}');
  });

  // A copy has to be the document, not a description of it: building the JSON from display
  // text quotes every value, turning 0.9 into "0.9" and true into "true".
  it("round-trips a mixed document back to its source values", () => {
    const source = '{"quality":0.9,"policy_pass":true,"tags":["a"],"note":"hi"}';
    expect(JSON.parse(stringifyMetadataEntries(parseMetadataEntries(source)))).toEqual(
      JSON.parse(source),
    );
  });

  it("omits internal keys from a copied document", () => {
    const copied = stringifyMetadataEntries(
      parseMetadataEntries('{"traceroot.sdk.name":"python","service":"api"}'),
    );
    expect(JSON.parse(copied)).toEqual({ service: "api" });
  });
});

describe("traceMetadataEntries", () => {
  // A thin read of `metadata_map`, so the stripping and verbatim-value invariants above hold
  // here too; what is pinned below is the source field it reads and how it reads an absent one.
  it("reads trace-level metadata off a list row", () => {
    expect(traceMetadataEntries(makeTrace({ session_id: "s-1" }))).toEqual([
      filterable("session_id", "s-1"),
    ]);
  });

  it("reads a row from an older server that carries no metadata field as having none", () => {
    const { metadata_map, ...withoutMetadataMap } = makeTrace({ session_id: "s-1" });
    void metadata_map;
    expect(traceMetadataEntries(withoutMetadataMap)).toEqual([]);
  });

  it("ignores the legacy metadata blob, which the list payload no longer carries", () => {
    // A row that only has the old blob field reads as no metadata: the column source
    // is `metadata_map`, so a server that stopped sending it must show blank cells
    // rather than the frontend quietly falling back to a field with different contents.
    const legacyRow = {
      ...makeTrace({}),
      metadata: '{"session_id":"s-1"}',
    } as TraceListItem;
    expect(traceMetadataEntries(legacyRow)).toEqual([]);
  });
});
