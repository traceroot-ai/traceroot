import { describe, it, expect } from "vitest";
import { PlanType } from "@traceroot/core";
import { getPlanButtonText, resolvePlanAction } from "./plan-actions";

describe("getPlanButtonText", () => {
  it("labels the user's current plan", () => {
    expect(getPlanButtonText(PlanType.FREE, PlanType.FREE)).toBe("Current Plan");
    expect(getPlanButtonText(PlanType.PRO, PlanType.PRO)).toBe("Current Plan");
  });

  it("labels Enterprise as Contact Sales", () => {
    expect(getPlanButtonText(PlanType.FREE, PlanType.ENTERPRISE)).toBe("Contact Sales");
    expect(getPlanButtonText(PlanType.PRO, PlanType.ENTERPRISE)).toBe("Contact Sales");
  });

  it("labels Free as Downgrade when on a paid plan", () => {
    expect(getPlanButtonText(PlanType.STARTER, PlanType.FREE)).toBe("Downgrade");
    expect(getPlanButtonText(PlanType.PRO, PlanType.FREE)).toBe("Downgrade");
  });

  it("labels higher plans as Upgrade", () => {
    expect(getPlanButtonText(PlanType.FREE, PlanType.STARTER)).toBe("Upgrade");
    expect(getPlanButtonText(PlanType.FREE, PlanType.PRO)).toBe("Upgrade");
    expect(getPlanButtonText(PlanType.STARTER, PlanType.PRO)).toBe("Upgrade");
  });

  it("labels lower paid plans as Downgrade", () => {
    expect(getPlanButtonText(PlanType.PRO, PlanType.STARTER)).toBe("Downgrade");
  });
});

describe("resolvePlanAction", () => {
  it("does nothing when selecting the current plan", () => {
    expect(resolvePlanAction(PlanType.PRO, PlanType.PRO, true)).toEqual({ type: "none" });
    expect(resolvePlanAction(PlanType.FREE, PlanType.FREE, false)).toEqual({ type: "none" });
  });

  it("routes Enterprise to contact sales regardless of subscription state", () => {
    expect(resolvePlanAction(PlanType.FREE, PlanType.ENTERPRISE, false)).toEqual({
      type: "contact-sales",
    });
    expect(resolvePlanAction(PlanType.PRO, PlanType.ENTERPRISE, true)).toEqual({
      type: "contact-sales",
    });
  });

  it("routes first-time subscribers to Stripe checkout for paid plans", () => {
    expect(resolvePlanAction(PlanType.FREE, PlanType.STARTER, false)).toEqual({
      type: "checkout",
    });
    expect(resolvePlanAction(PlanType.FREE, PlanType.PRO, false)).toEqual({ type: "checkout" });
  });

  it("routes existing subscribers to change-plan (upgrade, downgrade, or cancel to free)", () => {
    expect(resolvePlanAction(PlanType.FREE, PlanType.PRO, true)).toEqual({ type: "change-plan" });
    expect(resolvePlanAction(PlanType.PRO, PlanType.STARTER, true)).toEqual({
      type: "change-plan",
    });
    expect(resolvePlanAction(PlanType.PRO, PlanType.FREE, true)).toEqual({ type: "change-plan" });
  });

  it("routes a downgrade to Free without a subscription to change-plan, not checkout", () => {
    expect(resolvePlanAction(PlanType.PRO, PlanType.FREE, false)).toEqual({
      type: "change-plan",
    });
  });
});
