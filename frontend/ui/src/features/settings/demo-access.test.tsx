// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  workspace: undefined as { is_demo?: boolean; role?: string } | undefined,
  workspaceError: false,
  project: { workspace_id: "ws-demo" } as { workspace_id?: string } | undefined,
}));

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({
    data: state.workspace,
    error: state.workspaceError ? new Error("Workspace request failed") : null,
    isError: state.workspaceError,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: state.project, isError: false }),
}));
vi.mock("@/features/workspaces/components", () => ({ WorkspaceBreadcrumb: () => null }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { projectSettingsAccess, workspaceSettingsAccess } from "./demo-access";
import { ProjectSettingsLayout, WorkspaceSettingsLayout } from "./scoped-settings-layout";
import type { ProjectSettingsTab, WorkspaceSettingsTab } from "./settings-layout";

const DEMO_VIEWER = { is_demo: true, role: "VIEWER" };
const DEMO_MEMBER = { is_demo: true, role: "MEMBER" };
const DEMO_ADMIN = { is_demo: true, role: "ADMIN" };
const OTHER_VIEWER = { is_demo: false, role: "VIEWER" };
const OTHER_ADMIN = { is_demo: false, role: "ADMIN" };

const DENIED_WORKSPACE_TABS: WorkspaceSettingsTab[] = [
  "members",
  "model-providers",
  "integrations",
  "billing",
];
const DENIED_PROJECT_TABS: ProjectSettingsTab[] = ["accessKeys", "detectors"];

afterEach(() => {
  cleanup();
  state.workspace = undefined;
  state.workspaceError = false;
});

describe("settings access", () => {
  it.each(DENIED_WORKSPACE_TABS)("denies the workspace %s tab to a demo viewer", (tab) => {
    for (const ws of [DEMO_VIEWER, DEMO_MEMBER]) {
      expect(workspaceSettingsAccess(tab, ws)).toMatchObject({
        mode: "denied",
        message: expect.stringContaining("demo"),
      });
    }
  });

  it.each(DENIED_PROJECT_TABS)("denies the project %s tab to a demo viewer", (tab) => {
    for (const ws of [DEMO_VIEWER, DEMO_MEMBER]) {
      expect(projectSettingsAccess(tab, ws)).toMatchObject({
        mode: "denied",
        message: expect.stringContaining("demo"),
      });
    }
  });

  it("makes the General pages read-only for a demo viewer", () => {
    expect(workspaceSettingsAccess("general", DEMO_VIEWER)).toEqual({
      mode: "read-only",
      scope: "workspace",
    });
    expect(projectSettingsAccess("general", DEMO_VIEWER)).toEqual({
      mode: "read-only",
      scope: "project",
    });
  });

  it("gives full access to administrators in every workspace", () => {
    for (const ws of [DEMO_ADMIN, OTHER_ADMIN]) {
      for (const tab of ["general", ...DENIED_WORKSPACE_TABS] as WorkspaceSettingsTab[]) {
        expect(workspaceSettingsAccess(tab, ws)).toMatchObject({ mode: "full" });
      }
      for (const tab of ["general", ...DENIED_PROJECT_TABS] as ProjectSettingsTab[]) {
        expect(projectSettingsAccess(tab, ws)).toMatchObject({ mode: "full" });
      }
    }
  });

  it.each(["VIEWER", "MEMBER", "UNKNOWN", undefined])(
    "denies sensitive settings for a non-admin role %s",
    (role) => {
      const workspace = { is_demo: false, role };
      expect(workspaceSettingsAccess("billing", workspace)).toEqual({
        mode: "denied",
        title: "Workspace settings",
        message: "Billing settings are only available to workspace administrators.",
      });
      expect(projectSettingsAccess("detectors", workspace)).toEqual({
        mode: "denied",
        title: "Project settings",
        message: "Detector settings are only available to workspace administrators.",
      });
    },
  );

  it.each(["VIEWER", "UNKNOWN", undefined])(
    "denies API key settings for a role below MEMBER: %s",
    (role) => {
      expect(projectSettingsAccess("accessKeys", { is_demo: false, role })).toEqual({
        mode: "denied",
        title: "Project settings",
        message: "API key settings are only available to workspace members and administrators.",
      });
    },
  );

  it("keeps API key creation available to ordinary members", () => {
    expect(projectSettingsAccess("accessKeys", { is_demo: false, role: "MEMBER" })).toEqual({
      mode: "full",
    });
  });

  it("preserves access to other settings in ordinary workspaces", () => {
    for (const workspace of [OTHER_VIEWER, { is_demo: false, role: "MEMBER" }, {}]) {
      for (const tab of ["general", "members", "model-providers", "integrations"] as const) {
        expect(workspaceSettingsAccess(tab, workspace)).toEqual({ mode: "full" });
      }
      for (const tab of ["general", "labels"] as const) {
        expect(projectSettingsAccess(tab, workspace)).toEqual({ mode: "full" });
      }
    }
  });

  it("waits until the membership is known", () => {
    expect(workspaceSettingsAccess("members", undefined)).toEqual({ mode: "loading" });
    expect(workspaceSettingsAccess("billing", undefined)).toEqual({ mode: "loading" });
    expect(projectSettingsAccess("accessKeys", undefined)).toEqual({ mode: "loading" });
    expect(projectSettingsAccess("detectors", undefined)).toEqual({ mode: "loading" });
  });
});

const PAGE = (
  <>
    <label>
      Name
      <input defaultValue="Acme" />
    </label>
    <button type="button">Save</button>
    <p>Page content</p>
  </>
);

function renderWorkspacePage(tab: WorkspaceSettingsTab) {
  return render(
    <WorkspaceSettingsLayout workspaceId="ws-demo" tab={tab}>
      {PAGE}
    </WorkspaceSettingsLayout>,
  );
}

function renderProjectPage(tab: ProjectSettingsTab) {
  return render(
    <ProjectSettingsLayout projectId="proj-1" tab={tab}>
      {PAGE}
    </ProjectSettingsLayout>,
  );
}

describe("the settings layouts for a demo viewer", () => {
  it("keeps every menu item and shows a demo settings explanation instead of the page", () => {
    state.workspace = DEMO_VIEWER;
    renderWorkspacePage("members");

    for (const tab of ["General", "Members", "Model providers", "Integrations", "Billing"]) {
      expect(screen.getByRole("link", { name: tab })).toBeTruthy();
    }
    expect(screen.getByText("Demo workspace settings")).toBeTruthy();
    expect(
      screen.getByText(
        "The member list is not available in this demo workspace. You can manage members in your own workspace.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it("reads the membership through the project and denies the detector settings", () => {
    state.workspace = DEMO_VIEWER;
    renderProjectPage("detectors");

    for (const tab of ["General", "API keys", "Detectors"]) {
      expect(screen.getByRole("link", { name: tab })).toBeTruthy();
    }
    expect(screen.getByRole("link", { name: "Workspace" }).getAttribute("href")).toBe(
      "/workspaces/ws-demo/settings/general",
    );
    expect(screen.getByText("Demo project settings")).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it("shows the General page with every input and button disabled", () => {
    state.workspace = DEMO_VIEWER;
    renderWorkspacePage("general");

    expect(screen.getByText("Page content")).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).matches(":disabled"),
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).matches(":disabled"),
    ).toBe(true);
  });

  it("renders nothing until the membership is known", () => {
    renderWorkspacePage("members");
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.queryByText("Demo workspace settings")).toBeNull();
  });
});

describe("the settings layouts when the workspace cannot be read", () => {
  it("offers a retry and hides the workspace tab controls", () => {
    state.workspaceError = true;
    renderWorkspacePage("members");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it("lets project settings handle a workspace lookup failure as before", () => {
    state.workspaceError = true;
    renderProjectPage("general");
    expect(screen.getByText("Page content")).toBeTruthy();
    expect(screen.queryByTestId("settings-read-only")).toBeNull();
  });
});

describe.each([
  ["a demo admin", DEMO_ADMIN],
  ["a viewer of another workspace", OTHER_VIEWER],
])("the settings layouts for %s", (_who, workspace) => {
  it.each(["workspace", "project"] as const)(
    "show the non-sensitive %s page as before, with working controls",
    (scope) => {
      state.workspace = workspace;
      if (scope === "workspace") renderWorkspacePage("members");
      else renderProjectPage("general");

      expect(screen.queryByText(`Demo ${scope} settings`)).toBeNull();
      expect(screen.getByText("Page content")).toBeTruthy();
      expect(
        (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).matches(":disabled"),
      ).toBe(false);
      expect(screen.queryByTestId("settings-read-only")).toBeNull();
    },
  );
});

describe.each(["VIEWER", "MEMBER"])("sensitive settings for an ordinary %s", (role) => {
  it("shows a permission explanation instead of billing data", () => {
    state.workspace = { is_demo: false, role };
    renderWorkspacePage("billing");

    expect(screen.getByText("Workspace settings")).toBeTruthy();
    expect(
      screen.getByText("Billing settings are only available to workspace administrators."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Billing" })).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("shows a permission explanation instead of detector settings", () => {
    state.workspace = { is_demo: false, role };
    renderProjectPage("detectors");

    expect(screen.getByText("Project settings")).toBeTruthy();
    expect(
      screen.getByText("Detector settings are only available to workspace administrators."),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Detectors" })).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

it("denies API key settings to an ordinary viewer but preserves member creation", () => {
  state.workspace = OTHER_VIEWER;
  const view = renderProjectPage("accessKeys");
  expect(
    screen.getByText(
      "API key settings are only available to workspace members and administrators.",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Page content")).toBeNull();

  state.workspace = { is_demo: false, role: "MEMBER" };
  view.rerender(
    <ProjectSettingsLayout projectId="proj-1" tab="accessKeys">
      {PAGE}
    </ProjectSettingsLayout>,
  );
  expect(screen.getByText("Page content")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
});
