// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConnectedAssistants } from "../ConnectedAssistants";

const connection = {
  id: "consent-1",
  clientName: "Claude",
  verifiedHost: "claude.ai",
  projectId: "p1",
  projectName: "Checkout agent",
  createdAt: "2026-11-01T00:00:00.000Z",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function renderComponent() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConnectedAssistants />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConnectedAssistants", () => {
  it("says so when no assistant is connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ connections: [] })),
    );
    renderComponent();
    expect(await screen.findByText("No assistants are connected.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Set up the MCP server" }).getAttribute("href")).toBe(
      "https://traceroot.ai/docs/mcp/get-started",
    );
  });

  it("lists each assistant with the project it is limited to", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ connections: [connection] })),
    );
    renderComponent();
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.getByText("Checkout agent")).toBeTruthy();
    expect(screen.getByText("Verified · claude.ai")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
  });

  it("tags an assistant that registered itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ connections: [{ ...connection, clientName: "Acme Helper", verifiedHost: null }] }),
      ),
    );
    renderComponent();
    expect(await screen.findByText("Self-registered")).toBeTruthy();
    expect(screen.queryByText(/Verified/)).toBeNull();
  });

  it("asks before disconnecting, naming what the assistant loses, and can be cancelled", async () => {
    const fetchMock = vi.fn(async () => json({ connections: [connection] }));
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Disconnect Claude?" })).toBeTruthy();
    expect(dialog.textContent).toContain("loses access to Checkout agent");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("disconnects an assistant and refreshes the list", async () => {
    let connected = true;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        connected = false;
        return json({ ok: true });
      }
      return json({ connections: connected ? [connection] : [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderComponent();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }),
    );

    await waitFor(() => expect(screen.getByText("No assistants are connected.")).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/connections/consent-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("shows why a disconnect failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "DELETE" ? json({}, 500) : json({ connections: [connection] }),
      ),
    );
    renderComponent();

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Disconnect" }),
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Could not disconnect");
  });
});
