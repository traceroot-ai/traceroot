// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";

type ProjectUpdatePayload = { name: string };

const mocks = vi.hoisted(() => ({
  project: {
    id: "p1",
    name: "Acme Project",
    workspace_id: "w1",
  },
  deleteProject: vi
    .fn<(workspaceId: string, projectId: string) => Promise<void>>()
    .mockResolvedValue(void 0),
  updateProject: vi
    .fn<(workspaceId: string, projectId: string, data: ProjectUpdatePayload) => Promise<void>>()
    .mockResolvedValue(void 0),
}));

vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: mocks.project, isLoading: false }),
}));

vi.mock("@/lib/api", () => ({
  updateProject: (workspaceId: string, projectId: string, data: ProjectUpdatePayload) =>
    mocks.updateProject(workspaceId, projectId, data),
  deleteProject: (workspaceId: string, projectId: string) =>
    mocks.deleteProject(workspaceId, projectId),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GeneralTab } from "./GeneralTab";

function renderTab() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <GeneralTab projectId="p1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.deleteProject.mockReset().mockResolvedValue(void 0);
  mocks.updateProject.mockReset().mockResolvedValue(void 0);
});

describe("GeneralTab project delete dialog", () => {
  it("pressing Enter with the exact project name triggers delete", async () => {
    renderTab();

    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByPlaceholderText("Project name");
    fireEvent.change(input, { target: { value: "Acme Project" } });

    // Press Enter
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify delete was called with workspace_id and projectId
    await waitFor(() => {
      expect(mocks.deleteProject).toHaveBeenCalledWith("w1", "p1");
    });
  });

  it("pressing Enter with a non-matching name does not trigger delete", async () => {
    renderTab();

    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByPlaceholderText("Project name");
    fireEvent.change(input, { target: { value: "Wrong Project" } });

    // Press Enter
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify delete was NOT called
    expect(mocks.deleteProject).not.toHaveBeenCalled();
  });

  it("pressing Enter while a delete is already pending does not double-submit", async () => {
    // Make deleteProject return a promise that never resolves
    mocks.deleteProject.mockReturnValue(new Promise(() => {}));

    renderTab();

    // Open the delete dialog
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));

    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByPlaceholderText("Project name");
    fireEvent.change(input, { target: { value: "Acme Project" } });

    // Press Enter twice
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      expect(within(dialog).getByRole("button", { name: /deleting/i }).disabled).toBe(true);
    });
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify delete was called exactly once
    expect(mocks.deleteProject).toHaveBeenCalledTimes(1);
    expect(mocks.deleteProject).toHaveBeenCalledWith("w1", "p1");
  });
});
