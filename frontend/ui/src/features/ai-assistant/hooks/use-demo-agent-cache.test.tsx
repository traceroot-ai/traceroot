// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({ userId: "admin" }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: state.userId } }, isPending: false }),
}));
vi.mock("@/lib/api", () => ({
  getProject: async () => ({ workspace_id: "demo" }),
  getWorkspace: async () => ({
    is_demo: true,
    role: state.userId === "admin" ? "ADMIN" : "VIEWER",
  }),
}));
import { useDemoAgentAccess } from "./use-demo-agent-access";
afterEach(cleanup);

it("does not reuse the admin's cached membership when switching to a viewer", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  state.userId = "admin";
  const { result, rerender } = renderHook(() => useDemoAgentAccess("project"), { wrapper });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.readOnly).toBe(false);
  state.userId = "viewer";
  rerender();
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.readOnly).toBe(true));
  expect(result.current.loading).toBe(false);
  client.clear();
});
