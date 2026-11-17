// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanType } from "@traceroot/core";

const api = vi.hoisted(() => ({ createCheckoutSession: vi.fn(), changePlan: vi.fn() }));
vi.mock("./api", () => api);

import { PricingDialog } from "./PricingDialog";

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

function renderDialog(props: Partial<React.ComponentProps<typeof PricingDialog>> = {}) {
  return render(
    <PricingDialog
      open
      onOpenChange={() => {}}
      workspaceId="ws-1"
      currentPlan={PlanType.FREE}
      hasSubscription={false}
      {...props}
    />,
  );
}

describe("PricingDialog promo code", () => {
  it("offers a promo code field for a first checkout", () => {
    renderDialog();
    expect(screen.getByLabelText("Promo code")).toBeTruthy();
  });

  it("does not offer it when the workspace already has a subscription", () => {
    renderDialog({ currentPlan: PlanType.STARTER, hasSubscription: true });
    expect(screen.queryByLabelText("Promo code")).toBeNull();
  });

  it("sends the entered code with the checkout request", async () => {
    api.createCheckoutSession.mockResolvedValue({ url: "about:blank" });
    renderDialog();
    fireEvent.change(screen.getByLabelText("Promo code"), { target: { value: "  LAUNCH " } });
    fireEvent.click(screen.getAllByRole("button", { name: /Upgrade/ })[1]);
    await waitFor(() => expect(api.createCheckoutSession).toHaveBeenCalled());
    expect(api.createCheckoutSession).toHaveBeenCalledWith("ws-1", PlanType.PRO, "LAUNCH");
  });

  it("sends no code when the field is empty", async () => {
    api.createCheckoutSession.mockResolvedValue({ url: "about:blank" });
    renderDialog();
    fireEvent.click(screen.getAllByRole("button", { name: /Upgrade/ })[1]);
    await waitFor(() => expect(api.createCheckoutSession).toHaveBeenCalled());
    expect(api.createCheckoutSession).toHaveBeenCalledWith("ws-1", PlanType.PRO, undefined);
  });

  it("shows the server's reason when the code is rejected", async () => {
    api.createCheckoutSession.mockRejectedValue(
      new Error("This promo code is not valid for the selected plan."),
    );
    renderDialog();
    fireEvent.change(screen.getByLabelText("Promo code"), { target: { value: "WRONG" } });
    fireEvent.click(screen.getAllByRole("button", { name: /Upgrade/ })[1]);
    expect(
      await screen.findByText("This promo code is not valid for the selected plan."),
    ).toBeTruthy();
  });
});
