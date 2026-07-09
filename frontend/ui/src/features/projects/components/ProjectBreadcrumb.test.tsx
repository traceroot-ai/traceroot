// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

const mocks = vi.hoisted(() => ({
  setHeaderContent: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p-1/traces",
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    setHeaderContent: mocks.setHeaderContent,
  }),
}));

vi.mock("@/features/workspaces/components", () => ({
  CreateWorkspaceDialog: () => null,
}));

vi.mock("./CreateProjectDialog", () => ({
  CreateProjectDialog: () => null,
}));

vi.mock("../hooks", () => ({
  useProject: () => ({
    data: {
      id: "p-1",
      name: "Project One",
      workspace_id: "w-1",
    },
  }),
}));

vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspaces: () => ({
    data: [
      { id: "w-1", name: "Workspace One" },
      { id: "w-2", name: "Workspace Two" },
    ],
  }),
  useWorkspace: () => ({
    data: {
      id: "w-1",
      name: "Workspace One",
      projects: [
        { id: "p-1", name: "Project One" },
        { id: "p-2", name: "Project Two" },
      ],
    },
  }),
}));

import { ProjectBreadcrumb } from "./ProjectBreadcrumb";

afterEach(() => {
  cleanup();
  mocks.setHeaderContent.mockClear();
});

function latestBreadcrumbItems() {
  const call = mocks.setHeaderContent.mock.calls.find(([content]) => content !== null);
  return (
    call?.[0] as ReactElement<{
      items: Array<{ options?: Array<{ id: string; isCurrent?: boolean }> }>;
    }>
  ).props.items;
}

describe("ProjectBreadcrumb", () => {
  it("marks the current workspace and project options", async () => {
    render(<ProjectBreadcrumb projectId="p-1" />);

    await waitFor(() => expect(mocks.setHeaderContent).toHaveBeenCalled());
    const [workspaceItem, projectItem] = latestBreadcrumbItems();

    expect(workspaceItem.options?.find((option) => option.id === "w-1")?.isCurrent).toBe(true);
    expect(workspaceItem.options?.find((option) => option.id === "w-2")?.isCurrent).toBe(false);
    expect(projectItem.options?.find((option) => option.id === "p-1")?.isCurrent).toBe(true);
    expect(projectItem.options?.find((option) => option.id === "p-2")?.isCurrent).toBe(false);
  });
});
