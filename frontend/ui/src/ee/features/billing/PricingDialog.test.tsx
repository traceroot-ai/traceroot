// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const layout = vi.hoisted(() => ({ loopsEnabled: true }));
vi.mock("@/components/layout/app-layout", () => ({ useLayout: () => layout }));
vi.mock("./api", () => ({ createCheckoutSession: vi.fn(), changePlan: vi.fn() }));

import { PricingDialog } from "./PricingDialog";

beforeEach(() => {
  layout.loopsEnabled = true;
});
afterEach(cleanup);

const open = () => render(<PricingDialog open onOpenChange={() => {}} workspaceId="ws-1" />);

describe("PricingDialog", () => {
  it("lists the plans' loop runs while loops are on", () => {
    open();
    expect(screen.getByText("30 Loop runs / month")).toBeTruthy();
    expect(screen.getByText("Unlimited detector and Loop runs")).toBeTruthy();
  });

  it("drops the loop lines, keeping unlimited detector runs, where loops are switched off", () => {
    layout.loopsEnabled = false;
    open();
    expect(screen.queryByText(/loop/i)).toBeNull();
    expect(screen.getByText("100 detector runs / month")).toBeTruthy();
    expect(screen.getByText("Unlimited detector runs")).toBeTruthy();
  });
});
