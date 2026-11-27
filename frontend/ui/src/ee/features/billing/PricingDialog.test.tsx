// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlanType, Role } from "@traceroot/core";
import { changePlan, createCheckoutSession } from "./api";
import { PricingDialog } from "./PricingDialog";

const state = vi.hoisted(() => ({ role: "ADMIN" as string | undefined, isPending: false }));

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({
    data: state.role ? { role: state.role } : undefined,
    isPending: state.isPending,
  }),
}));

vi.mock("./api", () => ({
  changePlan: vi.fn(),
  createCheckoutSession: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  state.role = Role.ADMIN;
  state.isPending = false;
});

describe("PricingDialog", () => {
  it.each([Role.VIEWER, Role.MEMBER, "UNKNOWN", undefined])(
    "shows administrator guidance instead of a default Free plan for role %s",
    (role) => {
      state.role = role;
      render(<PricingDialog open onOpenChange={vi.fn()} workspaceId="ws_1" />);

      expect(
        screen.getByText(
          "Contact a workspace administrator to view or change this workspace's plan.",
        ),
      ).toBeTruthy();
      expect(screen.queryByText("Free")).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Current Plan|Upgrade|Downgrade|Contact Sales/ }),
      ).toBeNull();
      expect(createCheckoutSession).not.toHaveBeenCalled();
      expect(changePlan).not.toHaveBeenCalled();
    },
  );

  it("waits for workspace membership before showing plan interactions", () => {
    state.role = undefined;
    state.isPending = true;
    const { rerender } = render(<PricingDialog open onOpenChange={vi.fn()} workspaceId="ws_1" />);

    expect(screen.getByText("Loading workspace...")).toBeTruthy();
    expect(screen.queryByText("Current Plan")).toBeNull();
    expect(createCheckoutSession).not.toHaveBeenCalled();
    expect(changePlan).not.toHaveBeenCalled();

    state.role = Role.ADMIN;
    state.isPending = false;
    rerender(<PricingDialog open onOpenChange={vi.fn()} workspaceId="ws_1" />);
    expect(screen.getByRole("button", { name: "Current Plan" })).toBeTruthy();
  });

  it("keeps checkout available to administrators without a subscription", async () => {
    vi.mocked(createCheckoutSession).mockRejectedValue(new Error("Checkout unavailable"));
    render(<PricingDialog open onOpenChange={vi.fn()} workspaceId="ws_1" />);

    expect(screen.getByRole("button", { name: "Current Plan" })).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Upgrade" })[0]);

    expect(await screen.findByText("Checkout unavailable")).toBeTruthy();
    expect(createCheckoutSession).toHaveBeenCalledExactlyOnceWith("ws_1", PlanType.STARTER);
    expect(changePlan).not.toHaveBeenCalled();
  });

  it("keeps plan changes available to administrators with a subscription", async () => {
    vi.mocked(changePlan).mockResolvedValue({ success: false, message: "Unchanged" });
    render(
      <PricingDialog
        open
        onOpenChange={vi.fn()}
        workspaceId="ws_1"
        currentPlan={PlanType.STARTER}
        hasSubscription
      />,
    );

    expect(screen.getByRole("button", { name: "Current Plan" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    await waitFor(() => {
      expect(changePlan).toHaveBeenCalledExactlyOnceWith("ws_1", PlanType.PRO);
    });
    expect(createCheckoutSession).not.toHaveBeenCalled();
  });
});
