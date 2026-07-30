// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditDashboardDialog } from "./EditDashboardDialog";

const renameDashboard: {
  mutate: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
} = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null };

vi.mock("../hooks/use-dashboards", () => ({
  useDashboardMutations: vi.fn(() => ({ renameDashboard })),
}));
import { useDashboardMutations } from "../hooks/use-dashboards";

const TARGET = { id: "d2", name: "Costs", description: "Cost breakdowns" };

describe("EditDashboardDialog", () => {
  afterEach(cleanup);
  beforeEach(() => {
    renameDashboard.mutate.mockReset();
    renameDashboard.reset.mockReset();
    renameDashboard.isPending = false;
    renameDashboard.isError = false;
    renameDashboard.error = null;
  });

  it("prefills both fields and saves trimmed values, closing on success", () => {
    const onClose = vi.fn();
    render(<EditDashboardDialog projectId="p1" target={TARGET} onClose={onClose} />);

    // the mutation hook is bound to the row being edited
    expect(vi.mocked(useDashboardMutations)).toHaveBeenCalledWith("p1", "d2");

    const name = screen.getByLabelText("Dashboard name") as HTMLInputElement;
    const description = screen.getByLabelText("Dashboard description") as HTMLTextAreaElement;
    expect(name.value).toBe("Costs");
    expect(description.value).toBe("Cost breakdowns");

    fireEvent.change(name, { target: { value: "  Spend  " } });
    fireEvent.change(description, { target: { value: "  Monthly spend  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(renameDashboard.mutate).toHaveBeenCalledTimes(1);
    const [payload, options] = renameDashboard.mutate.mock.calls[0];
    expect(payload).toEqual({ name: "Spend", description: "Monthly spend" });
    options.onSuccess();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clearing the description saves null so the stored one is removed", () => {
    render(<EditDashboardDialog projectId="p1" target={TARGET} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Dashboard description"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(renameDashboard.mutate.mock.calls[0][0]).toEqual({ name: "Costs", description: null });
  });

  it("prefills an empty draft for a description-less dashboard", () => {
    render(
      <EditDashboardDialog
        projectId="p1"
        target={{ ...TARGET, description: null }}
        onClose={vi.fn()}
      />,
    );
    expect((screen.getByLabelText("Dashboard description") as HTMLTextAreaElement).value).toBe("");
  });

  it("cancel closes and resets without saving", () => {
    const onClose = vi.fn();
    render(<EditDashboardDialog projectId="p1" target={TARGET} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(renameDashboard.mutate).not.toHaveBeenCalled();
    expect(renameDashboard.reset).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("disables save for a blank name", () => {
    render(<EditDashboardDialog projectId="p1" target={TARGET} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Dashboard name"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });

  it("surfaces the mutation error and locks the dialog while saving is in flight", () => {
    renameDashboard.isError = true;
    renameDashboard.error = new Error("boom");
    renameDashboard.isPending = true;
    const onClose = vi.fn();
    render(<EditDashboardDialog projectId="p1" target={TARGET} onClose={onClose} />);

    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    // Radix close paths (Escape) are ignored while the save is pending.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no target", () => {
    render(<EditDashboardDialog projectId="p1" target={null} onClose={vi.fn()} />);
    expect(screen.queryByText("Edit Dashboard")).toBeNull();
  });
});
