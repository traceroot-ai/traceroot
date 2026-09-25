// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApiError } from "@/lib/api/errors";

type ProjectUpdatePayload = { name: string };

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
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
  useRouter: () => ({ push: mocks.push }),
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
  mocks.push.mockReset();
});

describe("GeneralTab project rename errors", () => {
  it.each([
    [new ApiError(403, "Requires ADMIN role or higher"), "Requires ADMIN role or higher"],
    [new Error("Network request failed"), "Network request failed"],
    [new Error(""), "Failed to rename project. Please try again."],
  ])("shows a failed rename and keeps the entered name for retry: %s", async (error, message) => {
    mocks.updateProject.mockRejectedValueOnce(error);
    renderTab();
    const input = screen.getByPlaceholderText("Project name");
    fireEvent.change(input, { target: { value: "New project name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
    expect(input).toHaveProperty("value", "New project name");
    expect(mocks.updateProject).toHaveBeenCalledWith("w1", "p1", { name: "New project name" });
    expect(mocks.push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updateProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("GeneralTab project delete dialog", () => {
  it("shows permission failures in the dialog without navigating, and allows retry", async () => {
    mocks.deleteProject.mockRejectedValueOnce(new ApiError(403, "Requires ADMIN role or higher"));
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Project name"), {
      target: { value: "Acme Project" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Requires ADMIN role or higher",
    );
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/workspaces/w1/projects"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("clears a previous delete error when reopening the dialog", async () => {
    mocks.deleteProject.mockRejectedValueOnce(new Error("Delete failed"));
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Project name"), {
      target: { value: "Acme Project" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
    await within(dialog).findByRole("alert");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));
    expect(within(screen.getByRole("dialog")).queryByRole("alert")).toBeNull();
  });

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
      expect(within(dialog).getByRole("button", { name: /deleting/i })).toHaveProperty(
        "disabled",
        true,
      );
    });
    fireEvent.keyDown(input, { key: "Enter" });

    // Verify delete was called exactly once
    expect(mocks.deleteProject).toHaveBeenCalledTimes(1);
    expect(mocks.deleteProject).toHaveBeenCalledWith("w1", "p1");
  });

  it("keeps a pending deletion disabled when the dialog is reopened", async () => {
    mocks.deleteProject.mockReturnValue(new Promise(() => {}));
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("Project name"), {
      target: { value: "Acme Project" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Project" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Deleting..." })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /delete project/i }));
    const reopened = screen.getByRole("dialog");
    expect(within(reopened).getByRole("button", { name: "Deleting..." })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.keyDown(within(reopened).getByPlaceholderText("Project name"), { key: "Enter" });
    expect(mocks.deleteProject).toHaveBeenCalledTimes(1);
  });
});
