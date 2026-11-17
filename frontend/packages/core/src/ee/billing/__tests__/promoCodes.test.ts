import { describe, it, expect } from "vitest";
import { discountsToKeepForPlan } from "../promoCodes.ts";

describe("discountsToKeepForPlan", () => {
  const d = (id: string, meta?: Record<string, string>) => ({
    id,
    coupon: { metadata: meta ?? {} },
  });

  it("drops plan-bound discounts that belong to another plan and keeps the rest", () => {
    const kept = discountsToKeepForPlan(
      [d("di_pro", { plan: "pro" }), d("di_starter", { plan: "starter" }), d("di_manual")],
      "pro",
    );
    expect(kept).toEqual(["di_pro", "di_manual"]);
  });

  it("returns an empty list when nothing applies", () => {
    expect(discountsToKeepForPlan([d("di_starter", { plan: "starter" })], "pro")).toEqual([]);
    expect(discountsToKeepForPlan([], "pro")).toEqual([]);
  });
});
