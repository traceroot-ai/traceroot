// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceSettingsLayout } from "./scoped-settings-layout";

vi.mock("@/features/workspaces/components", () => ({ WorkspaceBreadcrumb: () => null }));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("next/navigation", () => ({ usePathname: () => "/workspaces/qa/settings/general" }));

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WorkspaceSettingsLayout workspaceId="qa" tab="general">
        <button>Edit workspace</button>
      </WorkspaceSettingsLayout>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workspace settings", () => {
  it.each([403, 404])("links back to workspaces on HTTP %i", async (status) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: "Unavailable" }, { status }));
    vi.stubGlobal("fetch", fetch);
    renderSettings();
    expect(await screen.findByRole("heading", { name: "Workspace unavailable" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to your workspaces" }).getAttribute("href")).toBe(
      "/workspaces",
    );
    expect(screen.queryByRole("button", { name: "Edit workspace" })).toBeNull();
  });

  it("recovers from a failed request and renders an authorized workspace", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ id: "qa", role: "ADMIN", is_demo: false }));
    vi.stubGlobal("fetch", fetch);
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Edit workspace" })).toBeTruthy();
  });
});
