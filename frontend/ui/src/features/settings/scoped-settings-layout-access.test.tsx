// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ProjectSettingsLayout } from "./scoped-settings-layout";

const state = vi.hoisted(() => ({ projectError: false, workspaceError: false }));
vi.mock("@/features/workspaces/components", () => ({ WorkspaceBreadcrumb: () => null }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: { workspace_id: "ws" }, isError: state.projectError }),
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: { role: "ADMIN" }, isError: state.workspaceError }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/projects/p/settings/detectors" }));

afterEach(() => {
  cleanup();
  state.projectError = false;
  state.workspaceError = false;
});

describe("project settings access failures", () => {
  it.each(["projectError", "workspaceError"] as const)(
    "does not mount sensitive settings on %s despite cached admin data",
    (failure) => {
      state[failure] = true;
      const view = () => (
        <ProjectSettingsLayout projectId="p" tab="detectors">
          <div>Private notification recipients</div>
        </ProjectSettingsLayout>
      );
      const { rerender } = render(view());
      expect(screen.getByText("Project settings unavailable")).toBeTruthy();
      expect(screen.queryByText("Private notification recipients")).toBeNull();

      state[failure] = false;
      rerender(view());
      expect(screen.getByText("Private notification recipients")).toBeTruthy();
    },
  );
});
