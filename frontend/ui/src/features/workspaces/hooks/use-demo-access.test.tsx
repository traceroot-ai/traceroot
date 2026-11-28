// @vitest-environment jsdom
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ userId: "visitor-a" as string | null, api: vi.fn() }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: mocks.userId ? { user: { id: mocks.userId } } : null }),
}));
vi.mock("@/lib/api/client", () => ({ fetchNextApi: mocks.api }));
import { useDemoAccess } from "./use-demo-access";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.userId = "visitor-a";
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(useDemoAccess, { wrapper });
}

it("does not reuse another account's fresh membership state after switching accounts", async () => {
  mocks.api.mockImplementation(async () => ({
    available: true,
    joined: mocks.userId === "visitor-a",
    canLeave: mocks.userId === "visitor-a",
  }));
  const hook = mount();
  await waitFor(() => expect(hook.result.current.data?.canLeave).toBe(true));
  mocks.userId = "visitor-b";
  hook.rerender();
  expect(hook.result.current.data?.canLeave).not.toBe(true);
  await waitFor(() =>
    expect(hook.result.current.data).toEqual({ available: true, joined: false, canLeave: false }),
  );
  expect(mocks.api).toHaveBeenCalledTimes(2);
});

it("does not request membership state without an authenticated account", () => {
  mocks.userId = null;
  mount();
  expect(mocks.api).not.toHaveBeenCalled();
});
