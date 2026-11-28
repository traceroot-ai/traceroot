// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  push: vi.fn(),
  userId: "visitor" as string | null,
}));
vi.mock("@/lib/api/client", () => ({ fetchNextApi: mocks.api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({
    data: mocks.userId ? { user: { id: mocks.userId } } : null,
    isPending: false,
  }),
}));
import { DemoEntry } from "./demo-entry";

let access = { available: true, joined: false, canLeave: false };
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DemoEntry />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = "visitor";
  access = { available: true, joined: false, canLeave: false };
  mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      access = { available: true, joined: true, canLeave: true };
      return { projectId: "demo-project" };
    }
    if (options?.method === "DELETE") {
      access = { available: true, joined: false, canLeave: false };
      return { left: true };
    }
    return access;
  });
});
afterEach(cleanup);

it("offers sign-in instead of loading forever when the browser session has ended", () => {
  mocks.userId = null;
  mount();
  expect(
    screen.getByRole("link", { name: "Sign in to explore the demo" }).getAttribute("href"),
  ).toBe("/auth/sign-in?callbackUrl=%2Fdemo");
  expect(screen.queryByText("Loading demo...")).toBeNull();
  expect(mocks.api).not.toHaveBeenCalled();
});

it("does not join on load, then joins only after the explicit click", async () => {
  mount();
  const join = await screen.findByRole("button", { name: "Join demo" });
  expect(mocks.api.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
  fireEvent.click(join);
  expect(mocks.api.mock.calls[0]).toEqual(["/demo"]);
  await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/projects/demo-project/traces"));
  expect(mocks.api).toHaveBeenCalledWith("/demo", { method: "POST" });
});

it("offers only safe navigation when this deployment has no demo", async () => {
  access = { available: false, joined: false, canLeave: false };
  mount();
  expect(await screen.findByText("The demo is not available on this deployment.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Join demo" })).toBeNull();
  expect(screen.getByRole("link", { name: "Back to workspaces" }).getAttribute("href")).toBe(
    "/workspaces",
  );
  expect(mocks.api.mock.calls).toEqual([["/demo"]]);
});

it("allows a joined visitor to leave without rejoining", async () => {
  access = { available: true, joined: true, canLeave: true };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Leave demo" }));
  await screen.findByRole("button", { name: "Join demo" });
  expect(mocks.api).toHaveBeenCalledWith("/demo", { method: "DELETE" });
  expect(mocks.api.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
});

it("does not offer to remove a maintainer", async () => {
  access = { available: true, joined: true, canLeave: false };
  mount();
  await screen.findByRole("button", { name: "Open demo" });
  expect(screen.queryByRole("button", { name: "Leave demo" })).toBeNull();
});

it("shows a failed join without navigating", async () => {
  mocks.api.mockImplementation(async (_path: string, options?: RequestInit) => {
    if (options?.method === "POST") throw new Error("Could not join the demo");
    return access;
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Join demo" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not join the demo");
  expect(mocks.push).not.toHaveBeenCalled();
});

it("shows an availability error without offering membership writes", async () => {
  mocks.api.mockRejectedValue(new Error("Please sign in"));
  mount();
  expect((await screen.findByRole("alert")).textContent).toBe("Please sign in");
  expect(screen.queryByRole("button", { name: "Join demo" })).toBeNull();
});
