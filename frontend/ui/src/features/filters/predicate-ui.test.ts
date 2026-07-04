import { describe, it, expect } from "vitest";
import {
  predicateLabel,
  buildInPredicate,
  buildNumericPredicate,
  buildTextPredicate,
  upsertPredicate,
} from "./predicate-ui";

describe("predicateLabel", () => {
  it("renders a single-value `in` as an equality", () => {
    expect(predicateLabel({ field: "model_name", op: "in", value: ["claude-opus-4.8"] })).toBe(
      "model_name = claude-opus-4.8",
    );
  });

  it("renders a multi-value `in` as a list", () => {
    expect(
      predicateLabel({ field: "model_name", op: "in", value: ["claude-opus-4.8", "gpt-4"] }),
    ).toBe("model_name in [claude-opus-4.8, gpt-4]");
  });

  it("renders numeric comparison operators as their symbols", () => {
    expect(predicateLabel({ field: "cost", op: "eq", value: 5 })).toBe("cost = 5");
    expect(predicateLabel({ field: "cost", op: "gt", value: 0.5 })).toBe("cost > 0.5");
    expect(predicateLabel({ field: "cost", op: "gte", value: 0.5 })).toBe("cost ≥ 0.5");
    expect(predicateLabel({ field: "cost", op: "lt", value: 10 })).toBe("cost < 10");
    expect(predicateLabel({ field: "cost", op: "lte", value: 10 })).toBe("cost ≤ 10");
  });

  it("renders text `eq` as an equality and `contains` as `contains`", () => {
    expect(predicateLabel({ field: "trace_id", op: "eq", value: "abc123" })).toBe(
      "trace_id = abc123",
    );
    expect(predicateLabel({ field: "trace_id", op: "contains", value: "abc" })).toBe(
      "trace_id contains abc",
    );
  });

  it("uses the supplied display name in place of the raw field key", () => {
    expect(predicateLabel({ field: "duration_ms", op: "gte", value: 5 }, "latency")).toBe(
      "latency ≥ 5",
    );
    expect(predicateLabel({ field: "model_name", op: "in", value: ["gpt-4"] }, "model")).toBe(
      "model = gpt-4",
    );
  });
});

describe("predicate builders", () => {
  it("buildInPredicate makes a categorical `in` predicate", () => {
    expect(buildInPredicate("status", ["ERROR"])).toEqual({
      field: "status",
      op: "in",
      value: ["ERROR"],
    });
  });

  it("buildNumericPredicate makes a scalar numeric comparison predicate", () => {
    expect(buildNumericPredicate("cost", "gte", 0.5)).toEqual({
      field: "cost",
      op: "gte",
      value: 0.5,
    });
  });

  it("buildTextPredicate makes a scalar text predicate", () => {
    expect(buildTextPredicate("trace_id", "contains", "abc")).toEqual({
      field: "trace_id",
      op: "contains",
      value: "abc",
    });
  });
});

describe("upsertPredicate", () => {
  const gt = (f: string, v: number) => buildNumericPredicate(f, "gt", v);
  const gte = (f: string, v: number) => buildNumericPredicate(f, "gte", v);
  const lt = (f: string, v: number) => buildNumericPredicate(f, "lt", v);
  const lte = (f: string, v: number) => buildNumericPredicate(f, "lte", v);
  const eq = (f: string, v: number) => buildNumericPredicate(f, "eq", v);

  it("keeps a lower and an upper bound on the same field to form a range", () => {
    const afterLower = upsertPredicate([], gt("duration_ms", 5));
    const afterRange = upsertPredicate(afterLower, lte("duration_ms", 10));
    expect(afterRange).toEqual([gt("duration_ms", 5), lte("duration_ms", 10)]);
  });

  it("replaces a same-direction bound rather than stacking two lower bounds", () => {
    const start = [gt("duration_ms", 5), lte("duration_ms", 10)];
    expect(upsertPredicate(start, gte("duration_ms", 8))).toEqual([
      lte("duration_ms", 10),
      gte("duration_ms", 8),
    ]);
  });

  it("a new upper bound that contradicts the lower bound supersedes it (empty range)", () => {
    // errors ≥ 5 then errors ≤ 3 — no value satisfies both, so the newer one wins.
    expect(upsertPredicate([gte("errors", 5)], lte("errors", 3))).toEqual([lte("errors", 3)]);
  });

  it("a new lower bound that contradicts the upper bound supersedes it", () => {
    expect(upsertPredicate([lte("errors", 3)], gte("errors", 5))).toEqual([gte("errors", 5)]);
  });

  it("keeps equal INCLUSIVE bounds as an exact-value range (≥ x AND ≤ x matches x)", () => {
    expect(upsertPredicate([gte("errors", 5)], lte("errors", 5))).toEqual([
      gte("errors", 5),
      lte("errors", 5),
    ]);
  });

  it("drops equal bounds when either is STRICT (> x AND ≤ x at x is empty)", () => {
    // gt 5 then lte 5 — nothing satisfies x > 5 AND x <= 5, so the newer one wins.
    expect(upsertPredicate([gt("errors", 5)], lte("errors", 5))).toEqual([lte("errors", 5)]);
  });

  it("keeps a valid (non-empty) opposite bound: lower < upper", () => {
    expect(upsertPredicate([gt("duration_ms", 3)], lt("duration_ms", 5))).toEqual([
      gt("duration_ms", 3),
      lt("duration_ms", 5),
    ]);
  });

  it("an exact `eq` supersedes both range bounds on the field", () => {
    const start = [gte("cost", 1), lte("cost", 5)];
    expect(upsertPredicate(start, eq("cost", 3))).toEqual([eq("cost", 3)]);
  });

  it("a categorical value replaces the existing one on its field, untouched others", () => {
    const start = [gte("cost", 1), buildInPredicate("model_name", ["gpt-4o"])];
    expect(upsertPredicate(start, buildInPredicate("model_name", ["claude"]))).toEqual([
      gte("cost", 1),
      buildInPredicate("model_name", ["claude"]),
    ]);
  });

  it("a text predicate replaces any existing predicate on its field", () => {
    const start = [buildTextPredicate("trace_id", "contains", "abc")];
    expect(upsertPredicate(start, buildTextPredicate("trace_id", "eq", "xyz"))).toEqual([
      buildTextPredicate("trace_id", "eq", "xyz"),
    ]);
  });

  it("never touches predicates on other fields", () => {
    const start = [gte("duration_ms", 5), gte("cost", 1)];
    expect(upsertPredicate(start, lte("duration_ms", 10))).toEqual([
      gte("duration_ms", 5),
      gte("cost", 1),
      lte("duration_ms", 10),
    ]);
  });
});
