// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Workspace } from "@/types/api";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  getWorkspaces: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    // The id matters: this page caches the workspace list per account, so a
    // session without one leaves the query disabled and nothing to route on.
    useSession: () => ({
      data: { user: { id: "user-1", email: "kai@example.com" } },
      isPending: false,
    }),
  },
}));
vi.mock("@/lib/api", () => ({
  getWorkspaces: mocks.getWorkspaces,
}));

import Home from "./page";

function workspace(
  id: string,
  projectCount: number,
  role: Workspace["role"] = "ADMIN" as Workspace["role"],
): Workspace {
  return {
    id,
    name: id,
    role,
    member_count: 1,
    project_count: projectCount,
    create_time: "2026-10-14T00:00:00.000Z",
  };
}

function renderHome() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Home />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.getWorkspaces.mockReset();
});

describe("Home redirect", () => {
  it("sends a brand-new account to onboarding", async () => {
    mocks.getWorkspaces.mockResolvedValue([]);
    renderHome();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("asks only for the project when the account already owns an empty workspace", async () => {
    // Setup is finished once a project exists — the traces page, the access key
    // and the SDK snippet all hang off one, and `traceroot setup` cannot pick
    // up without one. Routing on workspace count alone sent anyone who quit
    // between the two calls to a workspace list whose single row opens on
    // nothing. Offering a second workspace would be the other wrong answer:
    // theirs exists, so the project form is the honest one, and it is the same
    // screen /device sends this case to.
    mocks.getWorkspaces.mockResolvedValue([workspace("ws-half", 0)]);
    renderHome();

    await waitFor(() =>
      expect(mocks.push).toHaveBeenCalledWith(
        "/onboarding?workspaceId=ws-half&workspaceName=ws-half",
      ),
    );
    expect(mocks.push).not.toHaveBeenCalledWith("/workspaces");
  });

  it("asks for a workspace when the only empty one cannot take a project", async () => {
    // A viewer cannot create a project in someone else's workspace, so the
    // project form would be a dead end — there is nowhere for this account to
    // put one but a workspace of its own.
    mocks.getWorkspaces.mockResolvedValue([
      workspace("ws-theirs", 0, "VIEWER" as Workspace["role"]),
    ]);
    renderHome();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/onboarding"));
  });

  it("sends a set-up user to their workspaces", async () => {
    mocks.getWorkspaces.mockResolvedValue([workspace("ws-1", 1)]);
    renderHome();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/workspaces"));
  });

  it("treats an empty workspace beside a populated one as deliberate, not unfinished", async () => {
    // Someone made a second workspace and has not filled it yet. Dragging that
    // account back through onboarding would be wrong.
    mocks.getWorkspaces.mockResolvedValue([workspace("ws-empty", 0), workspace("ws-1", 2)]);
    renderHome();

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/workspaces"));
    expect(mocks.push).not.toHaveBeenCalledWith("/onboarding");
  });
});
