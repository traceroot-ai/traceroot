// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { SidebarUpgradeButton } from "./SidebarUpgradeButton";
import { PlanType } from "@traceroot/core";
import { TooltipProvider } from "@/components/ui/tooltip";

// Define mock functions so they can be changed inside test cases
const mockUseProject = vi.fn();
const mockUseWorkspace = vi.fn();
const mockPricingDialog = vi.fn();

vi.mock("@/features/projects/hooks", () => ({
  useProject: (projectId: string) => mockUseProject(projectId),
}));

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: (workspaceId: string) => mockUseWorkspace(workspaceId),
}));

vi.mock("@/ee/features/billing/PricingDialog", () => ({
  PricingDialog: (props: any) => {
    mockPricingDialog(props);
    return <div data-testid="pricing-dialog" data-open={props.open ? "true" : "false"} />;
  },
}));

function renderWithProvider(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("SidebarUpgradeButton", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("should return disabled button when workspace is loading or undefined", () => {
    mockUseProject.mockReturnValue({ data: undefined });
    mockUseWorkspace.mockReturnValue({ data: undefined });

    renderWithProvider(<SidebarUpgradeButton projectId="p1" collapsed={false} />);

    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Upgrade");
    expect(mockUseProject).toHaveBeenCalledWith("p1");
    expect(mockUseWorkspace).toHaveBeenCalledWith("");
  });

  it("should return enabled button and show Upgrade text when not collapsed and workspace is loaded", () => {
    mockUseProject.mockReturnValue({ data: { workspace_id: "w1" } });
    mockUseWorkspace.mockReturnValue({
      data: {
        id: "w1",
        billingPlan: PlanType.FREE,
        billingSubscriptionId: null,
      },
    });

    renderWithProvider(<SidebarUpgradeButton projectId="p1" collapsed={false} />);

    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Upgrade");
    expect(mockUseWorkspace).toHaveBeenCalledWith("w1");

    const dialog = screen.getByTestId("pricing-dialog");
    expect(dialog.getAttribute("data-open")).toBe("false");
  });

  it("should not show Upgrade text on the button when collapsed is true", () => {
    mockUseProject.mockReturnValue({ data: undefined });
    mockUseWorkspace.mockReturnValue({
      data: {
        id: "w1",
        billingPlan: PlanType.PRO,
        billingSubscriptionId: "sub_123",
      },
    });

    renderWithProvider(<SidebarUpgradeButton workspaceId="w1" collapsed={true} />);

    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.textContent).not.toContain("Upgrade");

    const dialog = screen.getByTestId("pricing-dialog");
    expect(mockPricingDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        currentPlan: PlanType.PRO,
        hasSubscription: true,
      }),
    );
  });

  it("should fallback to PlanType.FREE if billingPlan is missing", () => {
    mockUseProject.mockReturnValue({ data: undefined });
    mockUseWorkspace.mockReturnValue({
      data: {
        id: "w1",
        // no billingPlan
      },
    });

    renderWithProvider(<SidebarUpgradeButton workspaceId="w1" collapsed={false} />);

    expect(mockPricingDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({
        workspaceId: "w1",
        currentPlan: PlanType.FREE,
        hasSubscription: false,
      }),
    );
  });

  it("should open PricingDialog when clicking the button", () => {
    mockUseProject.mockReturnValue({ data: undefined });
    mockUseWorkspace.mockReturnValue({
      data: {
        id: "w1",
        billingPlan: PlanType.PRO,
      },
    });

    renderWithProvider(<SidebarUpgradeButton workspaceId="w1" collapsed={false} />);

    const button = screen.getByRole("button");
    fireEvent.click(button);

    const dialog = screen.getByTestId("pricing-dialog");
    expect(dialog.getAttribute("data-open")).toBe("true");
  });

  it("should handle propWorkspaceId prioritisation over project workspace_id", () => {
    mockUseProject.mockReturnValue({ data: { workspace_id: "w-project" } });
    mockUseWorkspace.mockReturnValue({
      data: {
        id: "w-prop",
      },
    });

    renderWithProvider(
      <SidebarUpgradeButton projectId="p1" workspaceId="w-prop" collapsed={false} />,
    );

    expect(mockUseWorkspace).toHaveBeenCalledWith("w-prop");
  });
});
