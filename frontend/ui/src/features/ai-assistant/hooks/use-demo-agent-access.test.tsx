// @vitest-environment jsdom
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user" } }, isPending: false }),
}));
import { beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const state = vi.hoisted(() => ({
  project: {
    data: { workspace_id: "ws" } as { workspace_id: string } | undefined,
    isPending: false,
  },
  workspace: {
    data: { is_demo: false, role: "VIEWER" } as { is_demo: boolean; role: string } | undefined,
    isPending: false,
  },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) =>
    queryKey[0] === "project" ? state.project : state.workspace,
}));
import { useDemoAgentAccess } from "./use-demo-agent-access";

beforeEach(() => {
  state.project = { data: { workspace_id: "ws" }, isPending: false };
  state.workspace = { data: { is_demo: false, role: "VIEWER" }, isPending: false };
});
it.each(["VIEWER", "MEMBER"])("restricts demo %s", (role) => {
  state.workspace.data = { is_demo: true, role };
  expect(renderHook(() => useDemoAgentAccess("p")).result.current).toEqual({
    readOnly: true,
    loading: false,
  });
});
it("preserves demo admin interaction", () => {
  state.workspace.data = { is_demo: true, role: "ADMIN" };
  expect(renderHook(() => useDemoAgentAccess("p")).result.current.readOnly).toBe(false);
});
it("waits for enabled lookups", () => {
  state.workspace = { data: undefined, isPending: true };
  expect(renderHook(() => useDemoAgentAccess("p")).result.current.loading).toBe(true);
});
it("does not hide ordinary workspace controls forever after a failed lookup", () => {
  state.workspace = { data: undefined, isPending: false };
  expect(renderHook(() => useDemoAgentAccess("p")).result.current).toEqual({
    readOnly: false,
    loading: false,
  });
});
it("does not wait for a disabled workspace query after a project lookup fails", () => {
  state.project = { data: undefined, isPending: false };
  state.workspace = { data: undefined, isPending: true };
  expect(renderHook(() => useDemoAgentAccess("p")).result.current.loading).toBe(false);
});
