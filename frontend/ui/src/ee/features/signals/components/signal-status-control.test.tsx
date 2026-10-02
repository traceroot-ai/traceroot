// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }));

vi.mock("../hooks", () => ({
  useSetSignalStatus: () => ({
    mutate: mocks.mutate,
    reset: vi.fn(),
    isPending: false,
    error: null,
  }),
}));

// Radix Select and Dialog render through portals; native stand-ins let the
// test drive onValueChange and see the dialog body directly.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <select value={value} onChange={(e) => onValueChange(e.target.value)}>
      <option value="" />
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { SignalStatusControl } from "./signal-status-control";

afterEach(() => {
  cleanup();
  mocks.mutate.mockReset();
});

describe("SignalStatusControl", () => {
  it("saves against the status seen when the dialog opened", () => {
    const props = { projectId: "p1", signalId: "s1", title: "Tool times out" };
    const { rerender } = render(<SignalStatusControl {...props} status="open" />);

    const [statusSelect] = screen.getAllByRole("combobox");
    fireEvent.change(statusSelect, { target: { value: "resolved" } });
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Someone else dismisses the signal while the dialog is open.
    rerender(<SignalStatusControl {...props} status="dismissed" />);

    const reasonSelect = screen.getAllByRole("combobox")[1];
    fireEvent.change(reasonSelect, { target: { value: "fixed_by_pr" } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));

    expect(mocks.mutate).toHaveBeenCalledTimes(1);
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      change: { status: "resolved", reason: "fixed_by_pr", note: null },
      expectedStatus: "open",
    });
  });

  it("reopens against the current status without a dialog", () => {
    render(
      <SignalStatusControl projectId="p1" signalId="s1" title="Tool times out" status="resolved" />,
    );
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "open" } });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.mutate.mock.calls[0][0]).toEqual({
      change: { status: "open" },
      expectedStatus: "resolved",
    });
  });
});
