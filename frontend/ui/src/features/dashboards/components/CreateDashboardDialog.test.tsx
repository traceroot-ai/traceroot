// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

const createDashboard: {
  mutate: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
} = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null };

vi.mock("../hooks/use-dashboards", () => ({
  useDashboardMutations: () => ({ createDashboard }),
}));

import { CreateDashboardDialog } from "./CreateDashboardDialog";

describe("CreateDashboardDialog", () => {
  afterEach(cleanup);
  beforeEach(() => {
    push.mockReset();
    createDashboard.mutate.mockReset();
    createDashboard.reset.mockReset();
    createDashboard.isPending = false;
    createDashboard.isError = false;
    createDashboard.error = null;
  });

  function renderDialog() {
    const onOpenChange = vi.fn();
    render(<CreateDashboardDialog projectId="p1" open={true} onOpenChange={onOpenChange} />);
    return { onOpenChange };
  }

  it("autofocuses the name input when opened", () => {
    renderDialog();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Dashboard name"));
  });

  it("caps the name input at 50 characters", () => {
    renderDialog();
    expect(screen.getByPlaceholderText("Dashboard name").getAttribute("maxLength")).toBe("50");
  });

  it("disables Create until a non-blank name is entered", () => {
    renderDialog();
    const create = screen.getByRole("button", { name: "Create" });
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Dashboard name"), {
      target: { value: "   " },
    });
    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Dashboard name"), {
      target: { value: "Costs" },
    });
    expect(create.hasAttribute("disabled")).toBe(false);
  });

  it("submits the trimmed name, then closes and navigates on success", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Dashboard name"), {
      target: { value: "  New dash  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createDashboard.mutate).toHaveBeenCalledTimes(1);
    const [payload, options] = createDashboard.mutate.mock.calls[0];
    expect(payload).toEqual({ name: "New dash" });

    options.onSuccess({ dashboard: { id: "d9" } });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d9");
  });

  it("clears the draft name and mutation state when closed via Cancel", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.change(screen.getByPlaceholderText("Dashboard name"), {
      target: { value: "Draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createDashboard.reset).toHaveBeenCalled();
    expect((screen.getByPlaceholderText("Dashboard name") as HTMLInputElement).value).toBe("");
  });

  it("closes via Cancel without creating", () => {
    const { onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(createDashboard.mutate).not.toHaveBeenCalled();
  });

  it("shows the mutation error message and a pending Create label", () => {
    createDashboard.isPending = true;
    createDashboard.isError = true;
    createDashboard.error = new Error("boom");
    renderDialog();

    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Creating..." }).hasAttribute("disabled")).toBe(true);
  });
});
