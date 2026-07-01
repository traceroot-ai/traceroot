import { describe, it, expect } from "vitest";
import {
  predicateLabel,
  buildInPredicate,
  buildBetweenPredicate,
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

  it("renders an open lower bound as greater-than", () => {
    expect(predicateLabel({ field: "cost", op: "between", value: [0.5, null] })).toBe("cost > 0.5");
  });

  it("renders an open upper bound as less-than", () => {
    expect(predicateLabel({ field: "cost", op: "between", value: [null, 10] })).toBe("cost < 10");
  });

  it("renders a closed range as between", () => {
    expect(predicateLabel({ field: "cost", op: "between", value: [0.5, 10] })).toBe(
      "cost between 0.5 and 10",
    );
  });

  it("renders equal bounds (from `equals`) as `=`", () => {
    expect(predicateLabel({ field: "cost", op: "between", value: [5, 5] })).toBe("cost = 5");
  });

  it("uses the supplied display name in place of the raw field key", () => {
    expect(
      predicateLabel({ field: "duration_ms", op: "between", value: [5, null] }, "latency"),
    ).toBe("latency > 5");
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

  it("buildBetweenPredicate makes a numeric `between` predicate with nullable bounds", () => {
    expect(buildBetweenPredicate("cost", 0.5, null)).toEqual({
      field: "cost",
      op: "between",
      value: [0.5, null],
    });
  });
});

describe("upsertPredicate", () => {
  const gt = (f: string, lo: number) => buildBetweenPredicate(f, lo, null);
  const lt = (f: string, hi: number) => buildBetweenPredicate(f, null, hi);

  it("keeps a lower and an upper bound on the same field to form a range", () => {
    const afterLower = upsertPredicate([], gt("duration_ms", 5));
    const afterRange = upsertPredicate(afterLower, lt("duration_ms", 10));
    expect(afterRange).toEqual([gt("duration_ms", 5), lt("duration_ms", 10)]);
  });

  it("replaces a same-direction bound rather than stacking two lower bounds", () => {
    const start = [gt("duration_ms", 5), lt("duration_ms", 10)];
    expect(upsertPredicate(start, gt("duration_ms", 8))).toEqual([
      lt("duration_ms", 10),
      gt("duration_ms", 8),
    ]);
  });

  it("a new upper bound that contradicts the lower bound supersedes it (empty range)", () => {
    // errors > 5 then errors < 3 — no value satisfies both, so the newer one wins.
    expect(upsertPredicate([gt("errors", 5)], lt("errors", 3))).toEqual([lt("errors", 3)]);
  });

  it("a new lower bound that contradicts the upper bound supersedes it", () => {
    // errors < 3 then errors > 5 — the newer lower bound wins.
    expect(upsertPredicate([lt("errors", 3)], gt("errors", 5))).toEqual([gt("errors", 5)]);
  });

  it("treats equal bounds as an empty range (>= is inclusive, < is strict)", () => {
    // errors > 5 then errors < 5 — 5 <= x < 5 is empty, so the newer one wins.
    expect(upsertPredicate([gt("errors", 5)], lt("errors", 5))).toEqual([lt("errors", 5)]);
  });

  it("keeps a valid (non-empty) opposite bound: lower < upper", () => {
    expect(upsertPredicate([gt("duration_ms", 3)], lt("duration_ms", 5))).toEqual([
      gt("duration_ms", 3),
      lt("duration_ms", 5),
    ]);
  });

  it("an exact `equals` (both bounds equal) supersedes both range bounds", () => {
    const start = [gt("cost", 1), lt("cost", 5)];
    expect(upsertPredicate(start, buildBetweenPredicate("cost", 3, 3))).toEqual([
      buildBetweenPredicate("cost", 3, 3),
    ]);
  });

  it("a categorical value replaces the existing one on its field, untouched others", () => {
    const start = [gt("cost", 1), buildInPredicate("model_name", ["gpt-4o"])];
    expect(upsertPredicate(start, buildInPredicate("model_name", ["claude"]))).toEqual([
      gt("cost", 1),
      buildInPredicate("model_name", ["claude"]),
    ]);
  });

  it("never touches predicates on other fields", () => {
    const start = [gt("duration_ms", 5), gt("cost", 1)];
    expect(upsertPredicate(start, lt("duration_ms", 10))).toEqual([
      gt("duration_ms", 5),
      gt("cost", 1),
      lt("duration_ms", 10),
    ]);
  });
});
