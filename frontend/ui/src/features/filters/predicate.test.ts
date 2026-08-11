import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import type { Predicate } from "@/types/api";
import {
  canonicalizeFilters,
  isValidPredicate,
  serializeFiltersParam,
  parseFiltersParam,
  MAX_KEY_LENGTH,
} from "./predicate";

const modelFilter: Predicate = { field: "model_name", op: "in", value: ["a", "b"] };
const costFilter: Predicate = { field: "cost", op: "gte", value: 0.5 };
const metadataFilter: Predicate = {
  field: "metadata",
  key: "session_id",
  op: "eq",
  value: "abc",
};

describe("isValidPredicate (keyed fields)", () => {
  it("accepts a well-formed metadata predicate carrying a key", () => {
    expect(isValidPredicate(metadataFilter)).toBe(true);
  });

  it("accepts a metadata `contains` predicate", () => {
    expect(
      isValidPredicate({ field: "metadata", key: "user_id", op: "contains", value: "ab" }),
    ).toBe(true);
  });

  it("accepts a key that no discovery response ever suggested (suggestion is not permission)", () => {
    // The key binds as a parameter rather than an identifier, so an unknown key is a
    // legal filter that simply matches nothing — never a rejection.
    expect(
      isValidPredicate({ field: "metadata", key: "never_seen_key", op: "eq", value: "x" }),
    ).toBe(true);
  });

  // An empty key would reach the backend as a lookup for the "" key, which is not what any
  // surface displayed; a missing or non-string one has no key to look up at all.
  it.each([
    ["no key", { field: "metadata", op: "eq", value: "abc" }],
    ["an empty key", { field: "metadata", key: "", op: "eq", value: "abc" }],
    ["a key that is not a string", { field: "metadata", key: 7, op: "eq", value: "abc" }],
  ])("rejects a metadata predicate with %s", (_case, predicate) => {
    expect(isValidPredicate(predicate)).toBe(false);
  });

  it("rejects a key on a field that takes none", () => {
    // Ignoring the stray key instead would leave the chip, the URL, and the query the
    // backend runs describing different filters.
    expect(
      isValidPredicate({ field: "model_name", key: "session_id", op: "in", value: ["a"] }),
    ).toBe(false);
    expect(isValidPredicate({ field: "cost", key: "session_id", op: "gte", value: 1 })).toBe(false);
  });

  it("still accepts an unkeyed predicate on an unkeyed field", () => {
    expect(isValidPredicate(modelFilter)).toBe(true);
    expect(isValidPredicate(costFilter)).toBe(true);
  });

  it("rejects a metadata predicate with an empty value", () => {
    expect(isValidPredicate({ field: "metadata", key: "session_id", op: "eq", value: "" })).toBe(
      false,
    );
  });
});

describe("MAX_KEY_LENGTH", () => {
  it("accepts a key of exactly MAX_KEY_LENGTH characters", () => {
    // The cap is inclusive on both sides of the wire: a key the client admits at the
    // boundary must not be the one the backend 422s on the very next list request.
    expect(
      isValidPredicate({
        field: "metadata",
        key: "k".repeat(MAX_KEY_LENGTH),
        op: "eq",
        value: "x",
      }),
    ).toBe(true);
  });

  it("rejects a key one character past MAX_KEY_LENGTH", () => {
    // Rejected here rather than admitted and rejected later: an over-long key would
    // persist to the URL and to storage and then 422 every request until removed by hand.
    expect(
      isValidPredicate({
        field: "metadata",
        key: "k".repeat(MAX_KEY_LENGTH + 1),
        op: "eq",
        value: "x",
      }),
    ).toBe(false);
  });

  it("equals the backend cap in translate.py, which TypeScript cannot import from Python", () => {
    // Two independent declarations tied together by a comment: if they drift, the looser
    // side admits keys the other rejects and every list request 422s (or vice versa).
    const translatePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../backend/rest/services/filters/translate.py",
    );
    const match = readFileSync(translatePath, "utf8").match(/^MAX_KEY_LENGTH\s*=\s*(\d+)$/m);
    expect(match, `MAX_KEY_LENGTH is no longer declared in ${translatePath}`).not.toBeNull();
    expect(
      Number(match![1]),
      "the backend key-length cap moved — update MAX_KEY_LENGTH in features/filters/predicate.ts",
    ).toBe(MAX_KEY_LENGTH);
  });
});

describe("canonicalizeFilters", () => {
  it("is independent of predicate order — order-only differences collapse to one key", () => {
    const a = canonicalizeFilters([modelFilter, costFilter]);
    const b = canonicalizeFilters([costFilter, modelFilter]);
    expect(a).toBe(b);
  });

  it("distinguishes genuinely different filter sets", () => {
    const a = canonicalizeFilters([modelFilter]);
    const b = canonicalizeFilters([{ ...modelFilter, value: ["a", "c"] }]);
    expect(a).not.toBe(b);
  });

  it("maps empty and undefined to the same stable key", () => {
    expect(canonicalizeFilters([])).toBe(canonicalizeFilters(undefined));
  });

  it("produces different keys for two metadata predicates differing only by their key", () => {
    // Cache-collision regression: `metadata.session_id = x` and `metadata.user_id = x`
    // select different traces, so one cache entry would serve one filter's rows for the other.
    const bySession = canonicalizeFilters([
      { field: "metadata", key: "session_id", op: "eq", value: "x" },
    ]);
    const byUser = canonicalizeFilters([
      { field: "metadata", key: "user_id", op: "eq", value: "x" },
    ]);
    expect(bySession).not.toBe(byUser);
  });

  it("leaves an unkeyed predicate's cache key with no key member at all", () => {
    // Unkeyed predicates keep the exact shape their cache entries were written under: a
    // `"key":null` member would orphan every entry a running session had already filled.
    expect(canonicalizeFilters([costFilter])).toBe(
      JSON.stringify({ field: "cost", op: "gte", value: 0.5 }),
    );
    expect(canonicalizeFilters([costFilter])).not.toContain("key");
  });

  it("folds two identical metadata predicates to the same key", () => {
    const a = canonicalizeFilters([metadataFilter]);
    const b = canonicalizeFilters([
      { field: "metadata", key: "session_id", op: "eq", value: "abc" },
    ]);
    expect(a).toBe(b);
  });

  it("is independent of order when metadata predicates on two keys are both active", () => {
    const session: Predicate = { field: "metadata", key: "session_id", op: "eq", value: "a" };
    const user: Predicate = { field: "metadata", key: "user_id", op: "eq", value: "b" };
    expect(canonicalizeFilters([session, user])).toBe(canonicalizeFilters([user, session]));
  });

  it("folds an `in` value list that differs only in order to one key", () => {
    // The matched-value set is order-independent, so hover-prefetch and the list hook
    // must produce the same cache entry regardless of value order.
    const a = canonicalizeFilters([{ field: "model_name", op: "in", value: ["a", "b"] }]);
    const b = canonicalizeFilters([{ field: "model_name", op: "in", value: ["b", "a"] }]);
    expect(a).toBe(b);
  });
});

describe("serializeFiltersParam", () => {
  it("returns null for empty/undefined (no URL param emitted)", () => {
    expect(serializeFiltersParam(undefined)).toBeNull();
    expect(serializeFiltersParam([])).toBeNull();
  });

  it("round-trips a non-empty array through parse", () => {
    const raw = serializeFiltersParam([modelFilter, costFilter]);
    expect(raw).not.toBeNull();
    expect(parseFiltersParam(raw)).toEqual([modelFilter, costFilter]);
  });

  it("round-trips a metadata predicate's key through serialize and parse", () => {
    const raw = serializeFiltersParam([metadataFilter]);
    expect(parseFiltersParam(raw)).toEqual([metadataFilter]);
  });

  it("keeps two metadata keys distinct across a round-trip", () => {
    const filters: Predicate[] = [
      { field: "metadata", key: "session_id", op: "eq", value: "a" },
      { field: "metadata", key: "user_id", op: "contains", value: "b" },
    ];
    expect(parseFiltersParam(serializeFiltersParam(filters))).toEqual(filters);
  });

  it("drops a keyless metadata predicate on the way out", () => {
    const keyless = { field: "metadata", op: "eq", value: "abc" } as unknown as Predicate;
    expect(JSON.parse(serializeFiltersParam([modelFilter, keyless])!)).toEqual([modelFilter]);
  });

  it("drops invalid predicates on the way out (symmetric with parse)", () => {
    const emptyIn = { field: "model_name", op: "in", value: [] } as unknown as Predicate;
    // Assert the RAW serialized output — NOT laundered back through parseFiltersParam,
    // which would re-drop the empty `in` itself and make the test pass even if serialize
    // failed to filter. A serialize that kept it would yield a two-element array here.
    expect(JSON.parse(serializeFiltersParam([modelFilter, emptyIn])!)).toEqual([modelFilter]);
  });

  it("returns null when every predicate is invalid (no param emitted)", () => {
    const emptyIn = { field: "model_name", op: "in", value: [] } as unknown as Predicate;
    expect(serializeFiltersParam([emptyIn])).toBeNull();
  });
});

describe("parseFiltersParam", () => {
  it("returns [] for null or malformed JSON", () => {
    expect(parseFiltersParam(null)).toEqual([]);
    expect(parseFiltersParam("not json")).toEqual([]);
    expect(parseFiltersParam("{}")).toEqual([]); // not an array
  });

  it("drops predicates with an unknown operator or malformed value", () => {
    const raw = JSON.stringify([
      modelFilter,
      { field: "x", op: "like", value: ["y"] }, // unknown op
      { field: "cost", op: "gt", value: [1] }, // numeric op needs a number, not an array
      { field: "model_name", op: "in", value: "notarray" }, // wrong value type
    ]);
    expect(parseFiltersParam(raw)).toEqual([modelFilter]);
  });

  it("drops an empty `in` predicate (matches nothing; backend would 422 the list)", () => {
    const raw = JSON.stringify([modelFilter, { field: "model_name", op: "in", value: [] }]);
    expect(parseFiltersParam(raw)).toEqual([modelFilter]);
  });

  it("accepts numeric comparison and text predicates", () => {
    const preds: Predicate[] = [
      { field: "cost", op: "lte", value: 10 },
      { field: "trace_id", op: "contains", value: "abc" },
    ];
    expect(parseFiltersParam(JSON.stringify(preds))).toEqual(preds);
  });

  it("drops a hand-edited metadata predicate that lost its key", () => {
    const raw = JSON.stringify([modelFilter, { field: "metadata", op: "eq", value: "abc" }]);
    expect(parseFiltersParam(raw)).toEqual([modelFilter]);
  });

  it("keeps a metadata predicate whose key was never suggested", () => {
    const typed: Predicate = { field: "metadata", key: "typed_by_hand", op: "eq", value: "v" };
    expect(parseFiltersParam(JSON.stringify([typed]))).toEqual([typed]);
  });

  it("drops a numeric predicate with a non-finite value (1e999 -> Infinity)", () => {
    // JSON.parse turns 1e999 into Infinity; it must not survive validation (JSON.stringify
    // would coerce it back to null and corrupt the payload).
    expect(parseFiltersParam('[{"field":"cost","op":"gt","value":1e999}]')).toEqual([]);
  });
});
