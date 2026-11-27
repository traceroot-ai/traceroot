// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/errors";
import { ProjectSettingsLayout } from "./scoped-settings-layout";

const state = vi.hoisted(() => ({
  projectError: null as Error | null,
  workspaceError: null as Error | null,
  refetchProject: vi.fn(),
  refetchWorkspace: vi.fn(),
}));
vi.mock("@/features/workspaces/components", () => ({ WorkspaceBreadcrumb: () => null }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({
    data: { workspace_id: "ws" },
    error: state.projectError,
    refetch: state.refetchProject,
  }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({
    data: { role: "ADMIN" },
    error: state.workspaceError,
    refetch: state.refetchWorkspace,
  }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/projects/p/settings/detectors" }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.projectError = null;
  state.workspaceError = null;
});

const view = () => (
  <ProjectSettingsLayout projectId="p" tab="detectors">
    <div>Private notification recipients</div>
  </ProjectSettingsLayout>
);

describe.each(["projectError", "workspaceError"] as const)("project settings %s", (failure) => {
  it("hides cached administrator settings on request failure and retries that request", () => {
    state[failure] = new ApiError(503, "Unavailable");
    const { rerender } = render(view());
    expect(screen.getByRole("heading", { name: "Could not load project settings" })).toBeTruthy();
    expect(screen.queryByText("Private notification recipients")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    const retry = failure === "projectError" ? state.refetchProject : state.refetchWorkspace;
    expect(retry).toHaveBeenCalledOnce();

    state[failure] = null;
    rerender(view());
    expect(screen.getByText("Private notification recipients")).toBeTruthy();
  });

  it.each([403, 404])("links back to workspaces on HTTP %i", (status) => {
    state[failure] = new ApiError(status, "Unavailable");
    render(view());
    expect(screen.getByRole("heading", { name: "Project unavailable" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to your workspaces" }).getAttribute("href")).toBe(
      "/workspaces",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByText("Private notification recipients")).toBeNull();
  });
});
