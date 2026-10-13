// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  session: null as null | { user: { id: string } },
  workspaces: undefined as undefined | { id: string }[],
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: mocks.session, isPending: false }) },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.workspaces }),
}));
vi.mock("@/lib/api", () => ({ getWorkspaces: vi.fn() }));

import Home from "./page";

afterEach(() => {
  cleanup();
  mocks.push.mockReset();
  mocks.session = null;
  mocks.workspaces = undefined;
  window.history.replaceState({}, "", "/");
});

describe("Home redirects", () => {
  it("preserves campaign parameters when a stale session reaches the client fallback", () => {
    window.history.replaceState(
      {},
      "",
      "/?utm_source=github&utm_campaign=github-navigation&utm_content=readme-cloud-en&token=private",
    );
    render(<Home />);

    const destination = new URL(mocks.push.mock.calls[0][0], window.location.origin);
    expect(destination.pathname).toBe("/auth/sign-in");
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      utm_source: "github",
      utm_campaign: "github-navigation",
      utm_content: "readme-cloud-en",
    });
  });

  it("keeps the existing workspace destination for a signed-in user", () => {
    mocks.session = { user: { id: "user-1" } };
    mocks.workspaces = [{ id: "workspace-1" }];
    window.history.replaceState({}, "", "/?utm_source=github");
    render(<Home />);

    expect(mocks.push).toHaveBeenCalledOnce();
    expect(mocks.push).toHaveBeenCalledWith("/workspaces");
  });
});
