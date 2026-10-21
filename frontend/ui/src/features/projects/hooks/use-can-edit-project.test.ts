// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  project: { data: undefined, isError: false } as { data?: unknown; isError: boolean },
  workspace: { data: undefined, isError: false } as { data?: unknown; isError: boolean },
  useWorkspace: vi.fn(),
}));

vi.mock("./index", () => ({ useProject: () => mocks.project }));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: (workspaceId: string) => {
    mocks.useWorkspace(workspaceId);
    return mocks.workspace;
  },
}));

import { useCanEditProject } from "./use-can-edit-project";

afterEach(() => {
  cleanup();
  mocks.project = { data: undefined, isError: false };
  mocks.workspace = { data: undefined, isError: false };
  mocks.useWorkspace.mockReset();
});

const canEdit = () => renderHook(() => useCanEditProject("p1")).result.current;

describe("useCanEditProject", () => {
  it("says no while the role loads", () => {
    expect(canEdit()).toBe(false);
    mocks.project = { data: { workspace_id: "w1" }, isError: false };
    expect(canEdit()).toBe(false);
  });

  it.each([
    ["VIEWER", false],
    ["MEMBER", true],
    ["ADMIN", true],
  ])("follows the workspace role: %s", (role, expected) => {
    mocks.project = { data: { workspace_id: "w1" }, isError: false };
    mocks.workspace = { data: { id: "w1", role }, isError: false };
    expect(canEdit()).toBe(expected);
    expect(mocks.useWorkspace).toHaveBeenCalledWith("w1");
  });

  it("keeps a cached viewer role in charge when a refetch fails", () => {
    mocks.project = { data: { workspace_id: "w1" }, isError: false };
    mocks.workspace = { data: { id: "w1", role: "VIEWER" }, isError: true };
    expect(canEdit()).toBe(false);
  });

  it("says yes when the lookup fails, since the API stays the real check", () => {
    mocks.project = { data: undefined, isError: true };
    expect(canEdit()).toBe(true);
    mocks.project = { data: { workspace_id: "w1" }, isError: false };
    mocks.workspace = { data: undefined, isError: true };
    expect(canEdit()).toBe(true);
  });
});
