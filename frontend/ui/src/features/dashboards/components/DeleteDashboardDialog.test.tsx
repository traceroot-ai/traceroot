// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteDashboardDialog } from "./DeleteDashboardDialog";

const removeDashboard: {
  mutate: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
} = { mutate: vi.fn(), reset: vi.fn(), isPending: false, isError: false, error: null };

vi.mock("../hooks/use-dashboards", () => ({
  useDashboardMutations: () => ({ removeDashboard }),
}));

const TARGET = { id: "d2", name: "Costs" };

describe("DeleteDashboardDialog", () => {
  afterEach(cleanup);
  beforeEach(() => {
    removeDashboard.mutate.mockReset();
    removeDashboard.reset.mockReset();
    removeDashboard.isPending = false;
    removeDashboard.isError = false;
    removeDashboard.error = null;
  });

  it("deletes the target and closes on success", () => {
    const onClose = vi.fn();
    render(<DeleteDashboardDialog projectId="p1" target={TARGET} onClose={onClose} />);

    expect(screen.getByText(/Permanently delete “Costs”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(removeDashboard.mutate).toHaveBeenCalledTimes(1);
    const [id, options] = removeDashboard.mutate.mock.calls[0];
    expect(id).toBe("d2");
    options.onSuccess();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancel closes and resets the mutation so a stale error can't leak to the next target", () => {
    const onClose = vi.fn();
    render(<DeleteDashboardDialog projectId="p1" target={TARGET} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(removeDashboard.mutate).not.toHaveBeenCalled();
    expect(removeDashboard.reset).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces the mutation error and locks the dialog while deleting is in flight", () => {
    removeDashboard.isError = true;
    removeDashboard.error = new Error("boom");
    removeDashboard.isPending = true;
    const onClose = vi.fn();
    render(<DeleteDashboardDialog projectId="p1" target={TARGET} onClose={onClose} />);

    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    // Radix close paths (Escape) are ignored while the delete is pending.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing when there is no target", () => {
    render(<DeleteDashboardDialog projectId="p1" target={null} onClose={vi.fn()} />);
    expect(screen.queryByText("Delete Dashboard")).toBeNull();
  });
});
