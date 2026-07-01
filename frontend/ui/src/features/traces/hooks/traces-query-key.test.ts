import { describe, it, expect } from "vitest";
import { tracesQueryKey } from "./index";
import type { Predicate } from "@/types/api";

const model: Predicate = { field: "model_name", op: "in", value: ["a", "b"] };
const cost: Predicate = { field: "cost", op: "between", value: [0.5, null] };

describe("tracesQueryKey", () => {
  it("includes project id and all paging/filter fields in a stable order", () => {
    expect(
      tracesQueryKey("p1", {
        page: 2,
        limit: 50,
        search_query: "x",
        start_after: "S",
        end_before: "E",
        user_id: "u",
        session_id: "s",
      }),
      // trailing "" is the canonical (empty) filter key — see canonicalizeFilters.
    ).toEqual(["traces", "p1", 2, 50, "x", "S", "E", "u", "s", ""]);
  });

  it("fills undefined for omitted options so keys stay positionally stable", () => {
    expect(tracesQueryKey("p1", { page: 0, limit: 50 })).toEqual([
      "traces",
      "p1",
      0,
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "",
    ]);
  });

  it("is identical for filter arrays that differ only in order (one cache entry)", () => {
    expect(tracesQueryKey("p", { filters: [model, cost] })).toEqual(
      tracesQueryKey("p", { filters: [cost, model] }),
    );
  });

  it("differs once a filter is applied vs none", () => {
    expect(tracesQueryKey("p", { filters: [model] })).not.toEqual(tracesQueryKey("p", {}));
  });
});
