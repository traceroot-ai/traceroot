// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  value: { data: null, isPending: true } as {
    data: { session: { id: string; impersonatedBy?: string } } | null;
    isPending: boolean;
  },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      ...state.value,
      data: state.value.data ? { ...state.value.data, user: { email: "test@example.com" } } : null,
    }),
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin" }));
import { ImpersonationBanner } from "./impersonation-banner";
import { SUPPORT_ACTIVE_KEY } from "./exit";
beforeEach(() => {
  sessionStorage.setItem(SUPPORT_ACTIVE_KEY, "true");
  state.value = { data: null, isPending: true };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it("refreshes immediately when initial session restoration settles", async () => {
  const fetch = vi.fn(async () => Response.json({ impersonating: false }));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ImpersonationBanner />);
  expect(fetch).not.toHaveBeenCalled();
  state.value = { data: { session: { id: "employee" } }, isPending: false };
  view.rerender(<ImpersonationBanner />);
  await screen.findByText("Support session ended");
  expect(fetch).toHaveBeenCalledOnce();
});
it("discards a previous session response even if its JSON resolves after recovery", async () => {
  let finishJson!: (data: unknown) => void;
  const staleJson = new Promise((resolve) => {
    finishJson = resolve;
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => staleJson })
    .mockResolvedValueOnce(Response.json({ impersonating: false }));
  vi.stubGlobal("fetch", fetch);
  state.value = {
    data: { session: { id: "customer", impersonatedBy: "staff" } },
    isPending: false,
  };
  const view = render(<ImpersonationBanner />);
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  state.value = { data: { session: { id: "employee" } }, isPending: false };
  view.rerender(<ImpersonationBanner />);
  await screen.findByText("Support session ended");
  await act(async () => finishJson({ impersonating: true, valid: false }));
  expect(screen.getByText("Support session ended")).toBeTruthy();
});
it("keeps context details out of the banner", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        impersonating: true,
        valid: true,
        targetEmail: "customer@example.com",
        reason: "Private ticket note",
        workspace: { id: "workspace-1", name: "Customer Workspace" },
      }),
    ),
  );
  state.value = {
    data: { session: { id: "customer", impersonatedBy: "staff" } },
    isPending: false,
  };
  render(<ImpersonationBanner />);
  await screen.findByText("customer@example.com");
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(screen.queryByText(/Viewing as|Read-only|Read \+ write/)).toBeNull();
  expect(screen.queryByText(/Private ticket note|Reason:/)).toBeNull();
  expect(screen.queryByTitle("Private ticket note")).toBeNull();
  expect(screen.queryByText(/Customer Workspace|Workspace:/)).toBeNull();
});
it("does not claim restoration when no employee session exists", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ impersonating: false })),
  );
  state.value = { data: null, isPending: false };
  render(<ImpersonationBanner />);
  await screen.findByText("Support session ended");
  expect(screen.queryByText(/You are back on your employee account/)).toBeNull();
});
