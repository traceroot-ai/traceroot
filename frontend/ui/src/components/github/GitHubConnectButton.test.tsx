// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GitHubConnectButton } from "./GitHubConnectButton";

const state = vi.hoisted(() => ({ impersonating: false }));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { session: { impersonatedBy: state.impersonating ? "staff" : null } },
    }),
  },
}));
vi.mock("@/features/workspaces/hooks", () => ({
  useWorkspace: () => ({ data: { role: "ADMIN" } }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { connected: false }, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
afterEach(() => {
  cleanup();
  state.impersonating = false;
});

it("preserves Connect for a normal workspace admin", () => {
  render(<GitHubConnectButton workspaceId="ws" />);
  expect(screen.getByRole("link", { name: "Connect" })).toBeTruthy();
});

it("explains why an impersonator cannot connect instead of navigating to a JSON error", () => {
  state.impersonating = true;
  render(<GitHubConnectButton workspaceId="ws" />);
  expect(screen.getByRole("status").textContent).toContain("cannot be managed while impersonating");
  expect(screen.queryByRole("link", { name: "Connect" })).toBeNull();
});
