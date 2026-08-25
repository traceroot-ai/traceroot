// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => mocks.useSession(),
    listSessions: () => mocks.listSessions(),
    revokeSession: (args: { token: string }) => mocks.revokeSession(args),
    revokeOtherSessions: () => mocks.revokeOtherSessions(),
  },
}));

import { useActiveSessions } from "./useActiveSessions";

function sessionFor(userId: string, token: string) {
  return {
    id: `sess-${token}`,
    token,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    userId,
    expiresAt: "2026-09-01T00:00:00.000Z",
    ipAddress: "10.0.0.1",
    userAgent: "test",
  };
}

function makeWrapper() {
  // One QueryClient across rerenders — the point is what a SURVIVING cache
  // serves when the signed-in user changes underneath it.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { wrapper, queryClient };
}

afterEach(() => {
  cleanup();
  mocks.useSession.mockReset();
  mocks.listSessions.mockReset();
  mocks.revokeSession.mockReset();
  mocks.revokeOtherSessions.mockReset();
});

describe("useActiveSessions cache scoping", () => {
  it("does not fetch until the current user is known, and reports loading meanwhile", () => {
    mocks.useSession.mockReturnValue({ data: null, isPending: true });

    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useActiveSessions(), { wrapper });

    // The rows carry raw session tokens; an unattributed fetch could not be
    // cached under a user-scoped key, so no fetch may happen yet.
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.sessions).toEqual([]);
  });

  it("never serves one account's cached rows to another account", async () => {
    const userASession = sessionFor("user-a", "tok-a");
    mocks.useSession.mockReturnValue({ data: { session: userASession }, isPending: false });
    mocks.listSessions.mockResolvedValue({ data: [userASession], error: null });

    const { wrapper, queryClient } = makeWrapper();
    const { result, rerender } = renderHook(() => useActiveSessions(), { wrapper });
    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    expect(result.current.sessions[0].token).toBe("tok-a");

    // Same tab, same QueryClient: the signed-in user flips to B (an account
    // switch without a full page load). A's token-bearing rows must not
    // render for B — the user-scoped key forces a fresh, empty entry.
    const userBSession = sessionFor("user-b", "tok-b");
    mocks.useSession.mockReturnValue({ data: { session: userBSession }, isPending: false });
    mocks.listSessions.mockResolvedValue({ data: [userBSession], error: null });
    rerender();

    expect(result.current.sessions.map((s) => s.token)).not.toContain("tok-a");
    await waitFor(() => expect(result.current.sessions.map((s) => s.token)).toEqual(["tok-b"]));
    // Two distinct fetches — one per user-scoped cache entry.
    expect(mocks.listSessions).toHaveBeenCalledTimes(2);
    // And A's token-bearing entry is EVICTED, not just unrendered: once its
    // observer moved to B's key, gcTime 0 must drop it from the cache so it
    // isn't left readable in memory. Removing gcTime would fail this.
    await waitFor(() =>
      expect(queryClient.getQueryData(["account-settings", "sessions", "user-a"])).toBeUndefined(),
    );
  });
});
