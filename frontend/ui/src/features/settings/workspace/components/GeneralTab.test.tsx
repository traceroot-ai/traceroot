// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { Role as WorkspaceRole } from "@traceroot/core";

const mocks = vi.hoisted(() => ({
  workspace: {
    id: "w1",
    name: "Acme Corp",
    role: "ADMIN" satisfies WorkspaceRole,
  },
  deleteWorkspace: vi.fn<(workspaceId: string) => Promise<void>>().mockResolvedValue(void 0),
  updateWorkspace: vi
    .fn<(workspaceId: string, name: string) => Promise<void>>()
    .mockResolvedValue(void 0),
}));

vi.mock("../hooks", () => ({
  useWorkspace: () => ({ data: mocks.workspace, isLoading: false }),
}));

vi.mock("@/lib/api", () => ({
  updateWorkspace: (workspaceId: string, name: string) => mocks.updateWorkspace(workspaceId, name),
  deleteWorkspace: (workspaceId: string) => mocks.deleteWorkspace(workspaceId),
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

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByPlaceholderText("Workspace name");
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

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByPlaceholderText("Workspace name");
    fireEvent.change(input, { target: { value: "Wrong Name" } });

    // Press Enter
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify delete was NOT called
    expect(mocks.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("pressing Enter while a delete is already pending does not double-submit", async () => {
    // Make deleteWorkspace return a promise that never resolves
    mocks.deleteWorkspace.mockReturnValue(new Promise(() => {}));

    renderTab();

    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete workspace/i }));

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByPlaceholderText("Workspace name");
    fireEvent.change(input, { target: { value: "Acme Corp" } });

    // Press Enter twice
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /deleting/i }).disabled).toBe(true);
    });
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify delete was called exactly once
    expect(mocks.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.deleteWorkspace).toHaveBeenCalledWith("w1");
  });
});
