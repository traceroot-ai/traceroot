// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

import { ActiveSessions } from "../ActiveSessions";

const currentSession = {
  id: "sess-browser",
  token: "tok-current",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
  userId: "user-1",
  expiresAt: "2026-09-01T00:00:00.000Z",
  ipAddress: "10.0.0.1",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
};

const cliSession = {
  id: "sess-cli",
  token: "tok-cli",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-08T00:00:00.000Z",
  userId: "user-1",
  expiresAt: "2026-09-05T00:00:00.000Z",
  ipAddress: "10.0.0.2",
  userAgent: "traceroot-cli/1.2.3",
};

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ActiveSessions />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.useSession.mockReset();
  mocks.listSessions.mockReset();
  mocks.revokeSession.mockReset();
  mocks.revokeOtherSessions.mockReset();
});

describe("ActiveSessions", () => {
  it("renders a row for each session from listSessions, labeling the CLI session distinctly from the browser one", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions.mockResolvedValue({ data: [currentSession, cliSession], error: null });

    renderComponent();

    expect(await screen.findByText("TraceRoot CLI")).toBeTruthy();
    expect(screen.getByText(/Chrome on macOS/)).toBeTruthy();
    // The browser row must not also pick up the CLI's friendly label.
    expect(screen.getAllByText("TraceRoot CLI")).toHaveLength(1);
  });

  it("marks the current session distinctly and does not offer it a Revoke button", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions.mockResolvedValue({ data: [currentSession, cliSession], error: null });

    renderComponent();

    await screen.findByText("This device");
    const revokeButtons = await screen.findAllByRole("button", { name: /^revoke$/i });
    // Only the non-current (CLI) row gets a per-row Revoke button.
    expect(revokeButtons).toHaveLength(1);
  });

  it("revokes a non-current session by its token and refreshes the list", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions
      .mockResolvedValueOnce({ data: [currentSession, cliSession], error: null })
      .mockResolvedValueOnce({ data: [currentSession], error: null });
    mocks.revokeSession.mockResolvedValue({ data: { status: true }, error: null });

    renderComponent();

    await screen.findByText("TraceRoot CLI");
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => expect(mocks.revokeSession).toHaveBeenCalledWith({ token: "tok-cli" }));
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("TraceRoot CLI")).toBeNull());
  });

  it("revokes all other sessions and refreshes the list", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions
      .mockResolvedValueOnce({ data: [currentSession, cliSession], error: null })
      .mockResolvedValueOnce({ data: [currentSession], error: null });
    mocks.revokeOtherSessions.mockResolvedValue({ data: { status: true }, error: null });

    renderComponent();

    await screen.findByText("TraceRoot CLI");
    fireEvent.click(screen.getByRole("button", { name: /revoke all other sessions/i }));

    await waitFor(() => expect(mocks.revokeOtherSessions).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.listSessions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText("TraceRoot CLI")).toBeNull());
  });

  it("disables Revoke all other sessions when there is nothing else to revoke", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions.mockResolvedValue({ data: [currentSession], error: null });

    renderComponent();

    const button = await screen.findByRole("button", { name: /revoke all other sessions/i });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
  });

  it("does not remove the row and shows an error when revokeSession returns an error", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    // listSessions must not be called a second time: a failed revoke should
    // never trigger the onSuccess refresh path.
    mocks.listSessions.mockResolvedValue({ data: [currentSession, cliSession], error: null });
    mocks.revokeSession.mockResolvedValue({
      data: null,
      error: { message: "Session already expired" },
    });

    renderComponent();

    await screen.findByText("TraceRoot CLI");
    fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));

    await waitFor(() => expect(mocks.revokeSession).toHaveBeenCalledWith({ token: "tok-cli" }));
    expect(await screen.findByText("Session already expired")).toBeTruthy();
    // The row is still there — a failed revoke must not silently refresh as
    // if it had succeeded.
    expect(screen.getByText("TraceRoot CLI")).toBeTruthy();
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it("does not remove the row and shows an error when revokeOtherSessions returns an error", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions.mockResolvedValue({ data: [currentSession, cliSession], error: null });
    mocks.revokeOtherSessions.mockResolvedValue({
      data: null,
      error: { message: "Could not revoke other sessions" },
    });

    renderComponent();

    await screen.findByText("TraceRoot CLI");
    fireEvent.click(screen.getByRole("button", { name: /revoke all other sessions/i }));

    await waitFor(() => expect(mocks.revokeOtherSessions).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Could not revoke other sessions")).toBeTruthy();
    expect(screen.getByText("TraceRoot CLI")).toBeTruthy();
    expect(mocks.listSessions).toHaveBeenCalledTimes(1);
  });

  it("shows loading (no rows, no revoke controls) while the current session is still resolving", async () => {
    // authClient.useSession() pending, same shape as the device-client.tsx
    // sign-in gate. The list fetch is deliberately gated on the resolved user
    // (the rows carry raw session tokens, so an unattributed fetch can't be
    // cached under a user-scoped key) — so nothing token-bearing renders yet:
    // just the loading state, with no revoke control anywhere.
    mocks.useSession.mockReturnValue({ data: undefined, isPending: true });
    mocks.listSessions.mockResolvedValue({ data: [currentSession, cliSession], error: null });

    renderComponent();

    await screen.findByText("Loading sessions...");
    expect(mocks.listSessions).not.toHaveBeenCalled();
    expect(screen.queryByText("TraceRoot CLI")).toBeNull();
    expect(screen.queryByRole("button", { name: /^revoke$/i })).toBeNull();
  });

  it("shows an empty state when there are no sessions", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions.mockResolvedValue({ data: [], error: null });

    renderComponent();

    expect(await screen.findByText("No active sessions.")).toBeTruthy();
  });

  it("shows an error state when listSessions fails", async () => {
    mocks.useSession.mockReturnValue({ data: { session: currentSession }, isPending: false });
    mocks.listSessions.mockResolvedValue({
      data: null,
      error: { message: "Failed to load sessions" },
    });

    renderComponent();

    expect(await screen.findByText(/couldn't load your sessions/i)).toBeTruthy();
  });
});
