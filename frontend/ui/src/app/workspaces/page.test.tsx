// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  session: {
    data: { user: { id: "user-1" } } as { user: { id: string } } | null,
    isPending: false,
  },
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => mocks.session },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/components/layout/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/features/workspaces/components", () => ({ CreateWorkspaceDialog: () => null }));

import WorkspacesPage from "./page";

let queryClient: QueryClient;

beforeEach(() => {
  mocks.session = { data: { user: { id: "user-1" } }, isPending: false };
  mocks.push.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("keeps a returning user on the workspace list while their session is loading", () => {
  mocks.session = { data: null, isPending: true };
  const page = () => (
    <QueryClientProvider client={queryClient}>
      <WorkspacesPage />
    </QueryClientProvider>
  );
  const { rerender } = render(page());
  expect(mocks.push).not.toHaveBeenCalled();
  mocks.session = { data: null, isPending: false };
  rerender(page());
  expect(mocks.push).toHaveBeenCalledWith("/");
});
