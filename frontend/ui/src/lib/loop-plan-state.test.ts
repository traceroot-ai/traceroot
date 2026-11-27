import { beforeEach, describe, expect, it, vi } from "vitest";

const countFreeLoopRunsUsed = vi.fn();
const plan = { billing: true, loops: true };
vi.mock("@traceroot/core", () => ({
  prisma: {},
  PlanType: { FREE: "free", STARTER: "starter", PRO: "pro" },
  isBillingEnabled: () => plan.billing,
  isLoopRunBlocked: (p: string, runsUsed: number) => plan.billing && p === "free" && runsUsed >= 30,
}));
vi.mock("@traceroot/core/loops", () => ({
  countFreeLoopRunsUsed: (...args: unknown[]) => countFreeLoopRunsUsed(...args),
}));
vi.mock("@/lib/loops-enabled", () => ({ isLoopsEnabled: () => plan.loops }));

import { loopPlanState } from "./loop-plan-state";

const workspace = (billingPlan: string, loopBlocked: boolean, runsUsed: number) => ({
  id: "ws-1",
  billingPlan,
  loopBlocked,
  currentUsage: { ai: { runsUsed: 3 }, loop: { runsUsed, systemTokenCost: 0.5 } },
});

beforeEach(() => {
  countFreeLoopRunsUsed.mockReset();
  plan.billing = true;
  plan.loops = true;
});

describe("loopPlanState", () => {
  it("blocks a Free workspace once its live count reaches the cap, before the billing pass", async () => {
    countFreeLoopRunsUsed.mockResolvedValue(30);
    expect(await loopPlanState(workspace("free", false, 29))).toEqual({
      loopBlocked: true,
      currentUsage: { ai: { runsUsed: 3 }, loop: { runsUsed: 30, systemTokenCost: 0.5 } },
    });
    expect(countFreeLoopRunsUsed).toHaveBeenCalledWith(expect.anything(), "ws-1");
  });

  it("keeps the metered count when it is ahead of the live one", async () => {
    countFreeLoopRunsUsed.mockResolvedValue(10);
    expect(await loopPlanState(workspace("free", false, 12))).toMatchObject({
      loopBlocked: false,
      currentUsage: { loop: { runsUsed: 12 } },
    });
  });

  it("reads a Free workspace with no meter yet", async () => {
    countFreeLoopRunsUsed.mockResolvedValue(2);
    expect(
      await loopPlanState({
        id: "ws-1",
        billingPlan: "free",
        loopBlocked: false,
        currentUsage: null,
      }),
    ).toEqual({ loopBlocked: false, currentUsage: { loop: { runsUsed: 2 } } });
  });

  it("falls back to the stored state when the live count fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    countFreeLoopRunsUsed.mockRejectedValue(new Error("db unavailable"));
    const stored = workspace("free", false, 29);
    expect(await loopPlanState(stored)).toEqual({
      loopBlocked: false,
      currentUsage: stored.currentUsage,
    });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("returns the stored state for a paid plan, with billing off or with Loops off", async () => {
    const paid = workspace("pro", true, 40);
    expect(await loopPlanState(paid)).toEqual({
      loopBlocked: true,
      currentUsage: paid.currentUsage,
    });
    plan.billing = false;
    expect(await loopPlanState(workspace("free", false, 40))).toMatchObject({ loopBlocked: false });
    plan.billing = true;
    plan.loops = false;
    expect(await loopPlanState(workspace("free", false, 40))).toMatchObject({ loopBlocked: false });
    expect(countFreeLoopRunsUsed).not.toHaveBeenCalled();
  });
});
