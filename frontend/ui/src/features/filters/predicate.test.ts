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
