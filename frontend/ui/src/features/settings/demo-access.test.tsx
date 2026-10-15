// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({
  workspace: undefined as { is_demo?: boolean; role?: string } | undefined,
  workspaceError: false,
  project: { workspace_id: "ws-demo" } as { workspace_id?: string } | undefined,
}));

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: state.workspace, isError: state.workspaceError }),
}));
vi.mock("@/features/projects/hooks", () => ({
  useProject: () => ({ data: state.project, isError: false }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import {
  settingsAccess,
  useProjectSettingsAccess,
  useWorkspaceSettingsAccess,
  type SettingsSection,
} from "./demo-access";
import { PROJECT_SETTINGS_TABS, SettingsLayout, WORKSPACE_SETTINGS_TABS } from "./settings-layout";

const DEMO_VIEWER = { is_demo: true, role: "VIEWER" };
const DEMO_MEMBER = { is_demo: true, role: "MEMBER" };
const DEMO_ADMIN = { is_demo: true, role: "ADMIN" };
const OTHER_VIEWER = { is_demo: false, role: "VIEWER" };

const DENIED: [SettingsSection, string][] = [
  ["members", "the members of this workspace"],
  ["model-providers", "the model providers of this workspace"],
  ["integrations", "the integrations of this workspace"],
  ["billing", "the billing settings of this workspace"],
  ["access-keys", "the API keys of this project"],
  ["detectors", "the detector settings of this project"],
];

afterEach(() => {
  cleanup();
  state.workspace = undefined;
  state.workspaceError = false;
});

describe("settingsAccess", () => {
  it.each(DENIED)("denies %s to a demo viewer", (section, subject) => {
    for (const ws of [DEMO_VIEWER, DEMO_MEMBER]) {
      expect(settingsAccess(section, ws)).toEqual({
        mode: "denied",
        message: `You do not have permission to view ${subject}.`,
      });
    }
  });

  it("makes the General pages read-only for a demo viewer", () => {
    expect(settingsAccess("workspace-general", DEMO_VIEWER)).toEqual({ mode: "read-only" });
    expect(settingsAccess("project-general", DEMO_VIEWER)).toEqual({ mode: "read-only" });
  });

  it("gives full access to demo admins and to every role in other workspaces", () => {
    const sections: SettingsSection[] = [
      "workspace-general",
      "project-general",
      ...DENIED.map(([s]) => s),
    ];
    for (const ws of [DEMO_ADMIN, OTHER_VIEWER, { is_demo: false, role: "MEMBER" }, {}]) {
      for (const section of sections) {
        expect(settingsAccess(section, ws)).toEqual({ mode: "full" });
      }
    }
  });

  it("waits until the membership is known", () => {
    expect(settingsAccess("members", undefined)).toEqual({ mode: "loading" });
  });
});

describe("the access hooks", () => {
  it("read the workspace membership, through the project for project pages", () => {
    state.workspace = DEMO_VIEWER;
    expect(
      renderHook(() => useWorkspaceSettingsAccess("ws-demo", "billing")).result.current.mode,
    ).toBe("denied");
    expect(
      renderHook(() => useProjectSettingsAccess("proj-1", "access-keys")).result.current.mode,
    ).toBe("denied");
  });

  it("show the page as before when the workspace cannot be read", () => {
    state.workspaceError = true;
    expect(renderHook(() => useWorkspaceSettingsAccess("ws-x", "members")).result.current).toEqual({
      mode: "full",
    });
  });
});

function renderLayout(tabs: typeof WORKSPACE_SETTINGS_TABS, section: SettingsSection) {
  function Page() {
    const access = useWorkspaceSettingsAccess("ws-demo", section);
    return (
      <SettingsLayout tabs={tabs} activeTab="x" basePath="/settings" access={access}>
        <label>
          Name
          <input defaultValue="Acme" />
        </label>
        <button type="button">Save</button>
        <p>Page content</p>
      </SettingsLayout>
    );
  }
  return render(<Page />);
}

describe("SettingsLayout for a demo viewer", () => {
  it("keeps every menu item and shows an Access denied card instead of the page", () => {
    state.workspace = DEMO_VIEWER;
    renderLayout(WORKSPACE_SETTINGS_TABS, "members");

    for (const tab of ["General", "Members", "Model Providers", "Integrations", "Billing"]) {
      expect(screen.getByRole("link", { name: tab })).toBeTruthy();
    }
    expect(screen.getByText("Access denied")).toBeTruthy();
    expect(
      screen.getByText("You do not have permission to view the members of this workspace."),
    ).toBeTruthy();
    expect(screen.queryByText("Page content")).toBeNull();
  });

  it("keeps the project menu items and denies the detector settings", () => {
    state.workspace = DEMO_VIEWER;
    renderLayout(PROJECT_SETTINGS_TABS, "detectors");

    for (const tab of ["General", "API Keys", "Detectors"]) {
      expect(screen.getByRole("link", { name: tab })).toBeTruthy();
    }
    expect(screen.getByText("Access denied")).toBeTruthy();
  });

  it("shows the General page with every input and button disabled", () => {
    state.workspace = DEMO_VIEWER;
    renderLayout(WORKSPACE_SETTINGS_TABS, "workspace-general");

    expect(screen.getByText("Page content")).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).matches(":disabled"),
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).matches(":disabled"),
    ).toBe(true);
  });
});

describe.each([
  ["a demo admin", DEMO_ADMIN],
  ["a viewer of another workspace", OTHER_VIEWER],
])("SettingsLayout for %s", (_who, workspace) => {
  it("shows the page as before, with working controls", () => {
    state.workspace = workspace;
    renderLayout(WORKSPACE_SETTINGS_TABS, "members");

    expect(screen.queryByText("Access denied")).toBeNull();
    expect(screen.getByText("Page content")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).matches(":disabled"),
    ).toBe(false);
    expect(screen.queryByTestId("settings-read-only")).toBeNull();
  });
});
