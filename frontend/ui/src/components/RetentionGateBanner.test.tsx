// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  showPricing: false,
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws-1" } }),
}));

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({
    data: { billingPlan: "free", billingSubscriptionId: null },
  }),
}));

vi.mock("@/ee/features/billing/PricingDialog", () => ({
  PricingDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="pricing-dialog">Pricing</div> : null,
}));

import { RetentionGateBanner } from "./RetentionGateBanner";

const detail = {
  message: "Data outside retention window",
  retention_days: 15,
  cutoff: "2026-06-29T00:00:00",
  plan: "free",
};

afterEach(cleanup);

describe("RetentionGateBanner", () => {
  it("renders the list variant with plan and retention days", () => {
    render(<RetentionGateBanner projectId="proj-1" detail={detail} />);
    expect(screen.getByText(/Free plan includes 15 days/)).toBeTruthy();
    expect(screen.getByText(/Upgrade your plan/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Upgrade Plan" })).toBeTruthy();
  });

  it("renders the detail variant with trace-specific messaging", () => {
    render(<RetentionGateBanner projectId="proj-1" detail={detail} variant="detail" />);
    expect(screen.getByText("This trace is outside your retention window")).toBeTruthy();
    expect(screen.getByText(/Free plan retains the last 15 days/)).toBeTruthy();
  });

  it("opens the pricing dialog on button click", () => {
    render(<RetentionGateBanner projectId="proj-1" detail={detail} />);
    expect(screen.queryByTestId("pricing-dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Upgrade Plan" }));
    expect(screen.getByTestId("pricing-dialog")).toBeTruthy();
  });

  it("renders unknown plan names as-is", () => {
    render(<RetentionGateBanner projectId="proj-1" detail={{ ...detail, plan: "custom_plan" }} />);
    expect(screen.getByText(/custom_plan plan includes/)).toBeTruthy();
  });
});
