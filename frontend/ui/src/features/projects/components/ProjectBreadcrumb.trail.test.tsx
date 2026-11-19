// @vitest-environment jsdom
/**
 * ProjectBreadcrumb renders nothing itself — it pushes a <Breadcrumb> into the
 * app header. These tests capture what it pushes, so the trail's shape (labels,
 * hrefs, dropdown options, create actions) is checked directly.
 *
 * Complements ProjectBreadcrumb.test.tsx, which covers the current-option flags.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, act } from "@testing-library/react";
import type { BreadcrumbItem } from "@/components/layout/breadcrumb";

const state = vi.hoisted(() => ({
  project: undefined as unknown,
  workspace: undefined as unknown,
  workspaces: undefined as unknown,
  setHeaderContent: vi.fn(),
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({ setHeaderContent: state.setHeaderContent }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/proj-1/traces",
}));
vi.mock("../hooks", () => ({ useProject: () => ({ data: state.project }) }));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: state.workspace }),
  useWorkspaces: () => ({ data: state.workspaces }),
}));
vi.mock("./CreateProjectDialog", () => ({
  CreateProjectDialog: ({ open, workspaceId }: { open: boolean; workspaceId: string }) => (
    <div data-testid="create-project" data-open={String(open)} data-ws={workspaceId} />
  ),
}));
vi.mock("@/features/workspaces/components", () => ({
  CreateWorkspaceDialog: ({ open }: { open: boolean }) => (
    <div data-testid="create-workspace" data-open={String(open)} />
  ),
}));

import { ProjectBreadcrumb } from "./ProjectBreadcrumb";

/** The items from the most recent non-null header push. */
function pushedItems(): BreadcrumbItem[] {
  const calls = state.setHeaderContent.mock.calls.filter(([node]) => node !== null);
  const node = calls[calls.length - 1][0] as React.ReactElement<{ items: BreadcrumbItem[] }>;
  return node.props.items;
}

beforeEach(() => {
  state.project = { id: "proj-1", name: "Billing", workspace_id: "ws-1" };
  state.workspace = {
    id: "ws-1",
    name: "Acme",
    projects: [
      { id: "proj-1", name: "Billing" },
      { id: "proj-2", name: "Search" },
    ],
  };
  state.workspaces = [
    { id: "ws-1", name: "Acme" },
    { id: "ws-2", name: "Globex" },
  ];
  state.setHeaderContent.mockClear();
});
afterEach(() => cleanup());

describe("ProjectBreadcrumb trail", () => {
  it("pushes the workspace and project segments", () => {
    render(<ProjectBreadcrumb projectId="proj-1" />);
    const items = pushedItems();
    expect(items).toHaveLength(2);
    expect(items[0].label).toBe("Acme");
    expect(items[0].href).toBe("/workspaces/ws-1/projects");
    expect(items[1].label).toBe("Billing");
    // Nothing follows it, so the project is the current page and not a link.
    expect(items[1].href).toBeUndefined();
  });

  it("renders placeholder labels while the data loads", () => {
    state.project = undefined;
    state.workspace = undefined;
    state.workspaces = undefined;
    render(<ProjectBreadcrumb projectId="proj-1" />);
    const items = pushedItems();
    expect(items[0].label).toBe("...");
    expect(items[1].label).toBe("...");
    expect(items[0].href).toBeUndefined();
    expect(items[0].options).toBeUndefined();
    expect(items[1].options).toBeUndefined();
  });

  it("links the project once a current segment is appended", () => {
    render(<ProjectBreadcrumb projectId="proj-1" current="Settings" />);
    const items = pushedItems();
    expect(items[1].href).toBe("/projects/proj-1/traces");
    expect(items[2].label).toBe("Settings");
  });

  it("inserts trail segments between the project and the current page", () => {
    render(
      <ProjectBreadcrumb
        projectId="proj-1"
        trail={[{ label: "Datasets", href: "/projects/proj-1/datasets" }]}
        current="Billing routing"
      />,
    );
    expect(pushedItems().map((i) => i.label)).toEqual([
      "Acme",
      "Billing",
      "Datasets",
      "Billing routing",
    ]);
    // A trail alone is enough to make the project a link.
    expect(pushedItems()[1].href).toBe("/projects/proj-1/traces");
  });

  it("builds switcher options and menu headers for both segments", () => {
    render(<ProjectBreadcrumb projectId="proj-1" />);
    const items = pushedItems();
    expect(items[0].options?.map((o) => o.label)).toEqual(["Acme", "Globex"]);
    expect(items[0].options?.[0].settingsHref).toBe("/workspaces/ws-1/settings");
    expect(items[0].menuHeader).toEqual({ label: "Workspaces", href: "/workspaces" });

    expect(items[1].options?.map((o) => o.label)).toEqual(["Billing", "Search"]);
    expect(items[1].options?.[1].settingsHref).toBe("/projects/proj-2/settings");
    expect(items[1].menuHeader?.href).toBe("/workspaces/ws-1/projects");
  });

  it("opens the create dialogs from the segment create actions", () => {
    render(<ProjectBreadcrumb projectId="proj-1" />);
    expect(screen.getByTestId("create-workspace").dataset.open).toBe("false");
    expect(screen.getByTestId("create-project").dataset.open).toBe("false");
    expect(screen.getByTestId("create-project").dataset.ws).toBe("ws-1");

    const items = pushedItems();
    act(() => items[0].createNew!.onSelect());
    expect(screen.getByTestId("create-workspace").dataset.open).toBe("true");

    act(() => items[1].createNew!.onSelect());
    expect(screen.getByTestId("create-project").dataset.open).toBe("true");
  });

  it("omits the project dialog until the workspace is known", () => {
    state.project = { id: "proj-1", name: "Billing", workspace_id: null };
    render(<ProjectBreadcrumb projectId="proj-1" />);
    expect(screen.queryByTestId("create-project")).toBeNull();
  });

  it("does not re-push the header for an equivalent inline trail", () => {
    const { rerender } = render(
      <ProjectBreadcrumb projectId="proj-1" trail={[{ label: "Datasets" }]} />,
    );
    const calls = state.setHeaderContent.mock.calls.length;
    rerender(<ProjectBreadcrumb projectId="proj-1" trail={[{ label: "Datasets" }]} />);
    expect(state.setHeaderContent.mock.calls.length).toBe(calls);
  });

  it("clears the header on unmount", () => {
    const { unmount } = render(<ProjectBreadcrumb projectId="proj-1" />);
    unmount();
    expect(state.setHeaderContent).toHaveBeenLastCalledWith(null);
  });
});
