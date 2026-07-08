// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  workspace: {
    id: "w1",
    name: "Acme Corp",
    role: "ADMIN" as any,
  },
  deleteWorkspace: vi.fn().mockResolvedValue(void 0),
  updateWorkspace: vi.fn().mockResolvedValue(void 0),
}));

vi.mock("../hooks", () => ({
  useWorkspace: () => ({ data: mocks.workspace, isLoading: false }),
}));

vi.mock("@/lib/api", () => ({
  updateWorkspace: (...a: any[]) => mocks.updateWorkspace(...a),
  deleteWorkspace: (...a: any[]) => mocks.deleteWorkspace(...a),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Role } from "@traceroot/core";
import { GeneralTab } from "./GeneralTab";

function renderTab() {
  const qc = new QueryClient();
  // Delete section only renders for ADMIN role -- ensure it's set before each render.
  mocks.workspace.role = Role.ADMIN;

  return render(
    <QueryClientProvider client={qc}>
      <GeneralTab workspaceId="w1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.deleteWorkspace.mockReset().mockResolvedValue(void 0);
  mocks.updateWorkspace.mockReset().mockResolvedValue(void 0);
});

describe("GeneralTab workspace delete dialog", () => {
  it("pressing Enter with the exact workspace name triggers delete", async () => {
    renderTab();

    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));

    // Get the input from the dialog (the last one with this placeholder)
    const inputs = screen.getAllByPlaceholderText("Workspace name");
    const input = inputs[inputs.length - 1];
    fireEvent.change(input, { target: { value: "Acme Corp" } });

    // Press Enter
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify delete was called
    await waitFor(() => {
      expect(mocks.deleteWorkspace).toHaveBeenCalledWith("w1");
    });
  });

  it("pressing Enter with a non-matching name does not trigger delete", async () => {
    renderTab();

    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));

    // Get the input from the dialog (the last one with this placeholder)
    const inputs = screen.getAllByPlaceholderText("Workspace name");
    const input = inputs[inputs.length - 1];
    fireEvent.change(input, { target: { value: "Wrong Name" } });

    // Press Enter
    fireEvent.keyDown(input, { key: "Enter" });

    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 50));

    // Verify delete was NOT called
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("pressing Enter while a delete is already pending does not double-submit", async () => {
    // Make deleteWorkspace return a promise that never resolves
    mocks.deleteWorkspace.mockReturnValue(new Promise(() => {}));

    renderTab();

    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));

    // Get the input from the dialog (the last one with this placeholder)
    const inputs = screen.getAllByPlaceholderText("Workspace name");
    const input = inputs[inputs.length - 1];
    fireEvent.change(input, { target: { value: "Acme Corp" } });

    // Press Enter twice
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise((r) => setTimeout(r, 50));
    fireEvent.keyDown(input, { key: "Enter" });

    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 50));

    // Verify delete was called exactly once
    expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith("w1");
  });
});
