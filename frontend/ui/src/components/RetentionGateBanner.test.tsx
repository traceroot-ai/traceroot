// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

type MockWorkspace = { billingPlan?: string | null; billingSubscriptionId: string | null };

const mocks = vi.hoisted(() => ({
  showPricing: false,
  workspace: { billingPlan: "free", billingSubscriptionId: null } as MockWorkspace,
  currentPlan: undefined as string | undefined,
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: mocks.workspace }),
}));

vi.mock("@/ee/features/billing/PricingDialog", () => ({
  PricingDialog: ({ open, currentPlan }: { open: boolean; currentPlan: string }) => {
    mocks.currentPlan = currentPlan;
    return open ? <div data-testid="pricing-dialog">Pricing</div> : null;
  },
}));

import { RetentionGateBanner } from "./RetentionGateBanner";

const detail = {
  message: "Data outside retention window",
  retention_days: 15,
  cutoff: "2026-06-29T00:00:00",
  plan: "free",
};

beforeEach(() => {
  mocks.workspace = { billingPlan: "free", billingSubscriptionId: null };
  mocks.currentPlan = undefined;
});

afterEach(cleanup);

/** Mount the banner with a given stored billingPlan and read the plan the
 *  pricing dialog was handed. */
function currentPlanFor(billingPlan: string | null | undefined): string | undefined {
  mocks.workspace = { billingPlan, billingSubscriptionId: null };
  render(<RetentionGateBanner projectId="proj-1" detail={detail} />);
  return mocks.currentPlan;
}

describe("RetentionGateBanner", () => {
  it("renders trace-specific messaging with plan and retention days", () => {
    render(<RetentionGateBanner projectId="proj-1" detail={detail} />);
    expect(screen.getByText("This trace is outside your retention window")).toBeTruthy();
    expect(screen.getByText(/Free plan retains the last 15 days/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade Plan" })).toBeTruthy();
  });

  it("opens the pricing dialog on button click", () => {
    render(<RetentionGateBanner projectId="proj-1" detail={detail} />);
    expect(screen.queryByTestId("pricing-dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Upgrade Plan" }));
    expect(screen.getByTestId("pricing-dialog")).toBeTruthy();
  });

  it("renders unknown plan names as-is", () => {
    render(<RetentionGateBanner projectId="proj-1" detail={{ ...detail, plan: "custom_plan" }} />);
    expect(screen.getByText(/custom_plan plan retains the last/)).toBeTruthy();
  });
});

// billingPlan is free-form TEXT, and PricingDialog's CTA labelling is driven by
// getPlanOrder, which returns undefined for anything outside the enum: isUpgrade
// then reads false for every plan, so every card said "Downgrade" and none was
// marked current. The banner narrows the stored value instead of casting it.
describe("RetentionGateBanner plan narrowing", () => {
  it("passes a recognized plan through unchanged", () => {
    for (const plan of ["free", "starter", "pro", "enterprise"]) {
      cleanup();
      expect(currentPlanFor(plan)).toBe(plan);
    }
  });

  it("resolves an unrecognized plan to free", () => {
    for (const plan of ["legacy-team", "Pro", "pro ", "", null, undefined]) {
      cleanup();
      expect(currentPlanFor(plan)).toBe("free");
    }
  });
});
