import { describe, it, expect } from "vitest";
import type { Predicate } from "@/types/api";
import { canonicalizeFilters, serializeFiltersParam, parseFiltersParam } from "./predicate";

const modelFilter: Predicate = { field: "model_name", op: "in", value: ["a", "b"] };
const costFilter: Predicate = { field: "cost", op: "between", value: [0.5, null] };

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
      { field: "cost", op: "between", value: [1] }, // wrong arity
      { field: "model_name", op: "in", value: "notarray" }, // wrong value type
    ]);
    expect(parseFiltersParam(raw)).toEqual([modelFilter]);
  });

  it("drops an empty `in` predicate (matches nothing; backend would 422 the list)", () => {
    const raw = JSON.stringify([modelFilter, { field: "model_name", op: "in", value: [] }]);
    expect(parseFiltersParam(raw)).toEqual([modelFilter]);
  });

  it("accepts a between predicate with nullable open bounds", () => {
    const open: Predicate = { field: "cost", op: "between", value: [null, 10] };
    expect(parseFiltersParam(JSON.stringify([open]))).toEqual([open]);
  });

  it("drops a between predicate with a non-finite bound (1e999 -> Infinity)", () => {
    // JSON.parse turns 1e999 into Infinity; it must not survive validation — it would
    // JSON.stringify back to null, silently converting the bound to an open range.
    expect(parseFiltersParam('[{"field":"cost","op":"between","value":[1e999, null]}]')).toEqual(
      [],
    );
  });
});
