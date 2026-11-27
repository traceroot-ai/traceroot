// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { getProject, getWorkspace } from "@/lib/api";
import { useRetention } from "@/lib/hooks/use-retention";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";

const state = vi.hoisted(() => ({
  userId: "admin" as string | undefined,
  sessionPending: false,
  sessionRefetching: false,
  sessionError: null as Error | null,
  refetchSession: vi.fn(async () => {}),
}));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: state.userId ? { user: { id: state.userId } } : null,
    isPending: state.sessionPending,
    isRefetching: state.sessionRefetching,
    error: state.sessionError,
    refetch: state.refetchSession,
  }),
}));
vi.mock("@/lib/api", () => ({ getProject: vi.fn(), getWorkspace: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  state.userId = "admin";
  state.sessionPending = false;
  state.sessionRefetching = false;
  state.sessionError = null;
});

const resources = [
  [
    "workspace",
    useWorkspace,
    getWorkspace,
    { role: "ADMIN", billingPlan: "pro", currentUsage: { cost: 42 } },
  ],
  ["project", useProject, getProject, { name: "Project", alert_emails: ["private@example.test"] }],
] as const;

describe.each(resources)(
  "%s query isolation",
  (resource, useResource, getResource, privateData) => {
    it("never reuses the previous account's data while the new account is pending or fails", async () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
      });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      vi.mocked(getResource).mockResolvedValueOnce(privateData as never);
      const { result, rerender } = renderHook(() => useResource("same-id"), { wrapper });
      await waitFor(() => expect(result.current.data).toEqual(privateData));

      let fail!: (error: Error) => void;
      vi.mocked(getResource).mockImplementationOnce(
        () =>
          new Promise<never>((_resolve, reject) => {
            fail = reject;
          }),
      );
      state.userId = "viewer";
      rerender();
      expect(result.current.data).toBeUndefined();
      expect(result.current.isPending).toBe(true);
      await waitFor(() => expect(getResource).toHaveBeenCalledTimes(2));
      fail(new Error("Connection unavailable"));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
      expect(client.getQueryData([resource, "same-id", "admin"])).toEqual(privateData);
    });

    it("does not expose an unscoped cache entry before the session resolves", () => {
      state.userId = undefined;
      state.sessionPending = true;
      const client = new QueryClient();
      client.setQueryData([resource, "same-id"], privateData);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(() => useResource("same-id"), { wrapper });
      expect(result.current.data).toBeUndefined();
      expect(getResource).not.toHaveBeenCalled();
    });

    it("settles a missing identity as unauthorized without requesting private data", async () => {
      state.userId = undefined;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(() => useResource("same-id"), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.isPending).toBe(false);
      expect(result.current.error).toMatchObject({ status: 401 });
      expect(result.current.data).toBeUndefined();
      expect(getResource).not.toHaveBeenCalled();
    });

    it.each(["sessionPending", "sessionRefetching"] as const)(
      "does not trust cached session data during %s",
      (flag) => {
        state[flag] = true;
        const client = new QueryClient();
        client.setQueryData([resource, "same-id", "admin"], privateData);
        const wrapper = ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        );
        const { result } = renderHook(() => useResource("same-id"), { wrapper });
        expect(result.current.data).toBeUndefined();
        expect(getResource).not.toHaveBeenCalled();
      },
    );

    it("does not trust cached session data after a session request fails", async () => {
      state.sessionError = new Error("Session unavailable");
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData([resource, "same-id", "admin"], privateData);
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(() => useResource("same-id"), { wrapper });
      expect(result.current.data).toBeUndefined();
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toBeUndefined();
      expect(getResource).not.toHaveBeenCalled();
    });

    it("revalidates a failed session when the resource is retried", async () => {
      state.sessionError = new Error("Session unavailable");
      state.refetchSession.mockImplementation(async () => {
        state.sessionError = null;
      });
      vi.mocked(getResource).mockResolvedValue(privateData as never);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result, rerender } = renderHook(() => useResource("same-id"), { wrapper });
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(getResource).not.toHaveBeenCalled();
      await result.current.refetch();
      expect(state.refetchSession).toHaveBeenCalledOnce();
      rerender();
      await waitFor(() => expect(result.current.data).toEqual(privateData));
      expect(client.getQueryData([resource, "same-id", undefined])).toBeUndefined();
    });

    it("keeps existing resource-prefix invalidations effective", async () => {
      vi.mocked(getResource).mockResolvedValue(privateData as never);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(() => useResource("same-id"), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      await client.invalidateQueries({ queryKey: [resource, "same-id"] });
      expect(getResource).toHaveBeenCalledTimes(2);
    });
  },
);

it("fails retention closed after the session resolves without an identity", async () => {
  state.userId = undefined;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useRetention("project"), { wrapper });
  await waitFor(() => expect(result.current.retentionDays).toBe(15));
  expect(getProject).not.toHaveBeenCalled();
  expect(getWorkspace).not.toHaveBeenCalled();
});
