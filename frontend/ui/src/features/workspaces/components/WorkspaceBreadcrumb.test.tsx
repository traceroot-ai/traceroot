// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";

const mocks = vi.hoisted(() => ({
  setHeaderContent: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/workspaces/w-1/projects",
}));

vi.mock("@/components/layout/app-layout", () => ({
  useLayout: () => ({
    setHeaderContent: mocks.setHeaderContent,
  }),
}));

vi.mock("./CreateWorkspaceDialog", () => ({
  CreateWorkspaceDialog: () => null,
}));

vi.mock("../hooks", () => ({
  useWorkspace: () => ({
    data: {
      id: "w-1",
      name: "Workspace One",
    },
  }),
  useWorkspaces: () => ({
    data: [
      { id: "w-1", name: "Workspace One" },
      { id: "w-2", name: "Workspace Two" },
    ],
  }),
}));

import { WorkspaceBreadcrumb } from "./WorkspaceBreadcrumb";

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

describe("WorkspaceBreadcrumb", () => {
  it("marks the current workspace option", async () => {
    render(<WorkspaceBreadcrumb workspaceId="w-1" />);

    await waitFor(() => expect(mocks.setHeaderContent).toHaveBeenCalled());
    const [workspaceItem] = latestBreadcrumbItems();

    expect(workspaceItem.options?.find((option) => option.id === "w-1")?.isCurrent).toBe(true);
    expect(workspaceItem.options?.find((option) => option.id === "w-2")?.isCurrent).toBe(false);
  });
});
