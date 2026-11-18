// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  consent: vi.fn(),
  signOut: vi.fn(),
}));

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    oauth2: { consent: (...args: unknown[]) => mocks.consent(...args) },
    signOut: (...args: unknown[]) => mocks.signOut(...args),
  },
}));

import { ConsentClient } from "./consent-client";

const CLAUDE = { name: "Claude", verifiedHost: "claude.ai" };
const SELF_REGISTERED = { name: "Acme Helper", verifiedHost: null };
const QUERY = {
  client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
  redirect_uri: "https://claude.ai/api/mcp/auth_callback",
  sig: "signed",
};

function stubSelection(selection: { projectName: string; workspaceName: string | null } | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ selection }))),
  );
}

let location: { href: string };

beforeEach(() => {
  searchParams = new URLSearchParams(QUERY);
  location = { href: "" };
  Object.defineProperty(window, "location", { value: location, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ConsentClient", () => {
  it("says who vouches for a metadata-document client, with no unverified warning", async () => {
    stubSelection({ projectName: "mcp-e2e", workspaceName: "Acme" });
    render(<ConsentClient client={CLAUDE} accountEmail="kai@example.com" />);

    await screen.findByTestId("consent-project");
    expect(screen.getByText("claude.ai").parentElement?.textContent).toBe("Verified by claude.ai");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/registered itself/)).toBeNull();
  });

  it("warns, as a banner, that a self-registered client's name is unverified", async () => {
    stubSelection({ projectName: "mcp-e2e", workspaceName: "Acme" });
    render(<ConsentClient client={SELF_REGISTERED} accountEmail="kai@example.com" />);

    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("Unverified application");
    expect(banner.textContent).toContain("Acme Helper");
    expect(screen.queryByText(/Verified by/)).toBeNull();
  });

  it("shows the workspace next to the project only when it differs", async () => {
    stubSelection({ projectName: "mcp-e2e", workspaceName: "mcp-e2e" });
    render(<ConsentClient client={CLAUDE} />);
    expect((await screen.findByTestId("consent-project")).textContent).toBe("mcp-e2e");
    cleanup();

    stubSelection({ projectName: "mcp-e2e", workspaceName: "Acme" });
    render(<ConsentClient client={CLAUDE} />);
    expect((await screen.findByTestId("consent-project")).textContent).toBe("mcp-e2e · Acme");
  });

  it("shows who is granting access and that the access is read-only", async () => {
    stubSelection({ projectName: "mcp-e2e", workspaceName: "Acme" });
    render(<ConsentClient client={CLAUDE} accountEmail="kai@example.com" />);

    await screen.findByTestId("consent-project");
    expect(screen.getByText("as kai@example.com")).toBeTruthy();
    expect(screen.getByText("Access").nextElementSibling?.textContent).toContain("Read-only.");
  });

  it("names the action on the primary button and approves with it", async () => {
    stubSelection({ projectName: "mcp-e2e", workspaceName: null });
    mocks.consent.mockResolvedValue({ data: { url: "https://claude.ai/cb?code=x" }, error: null });
    render(<ConsentClient client={CLAUDE} />);

    const allow = await screen.findByRole("button", { name: "Allow Claude to read mcp-e2e" });
    expect(screen.getByText("Returns to").nextElementSibling?.textContent).toBe(
      "https://claude.ai",
    );
    fireEvent.click(allow);

    await waitFor(() => expect(location.href).toBe("https://claude.ai/cb?code=x"));
    expect(mocks.consent).toHaveBeenCalledWith({ accept: true });
    expect(screen.getByRole("status").textContent).toContain(
      "Taking you back to https://claude.ai",
    );
  });

  it("refuses with Cancel", async () => {
    stubSelection({ projectName: "mcp-e2e", workspaceName: null });
    mocks.consent.mockResolvedValue({ data: { url: "https://claude.ai/cb?error=x" }, error: null });
    render(<ConsentClient client={CLAUDE} />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(mocks.consent).toHaveBeenCalledWith({ accept: false }));
  });

  it("signs out and restarts the same authorization to switch account", async () => {
    stubSelection({ projectName: "mcp-e2e", workspaceName: null });
    mocks.signOut.mockResolvedValue({});
    render(<ConsentClient client={CLAUDE} accountEmail="kai@example.com" />);

    fireEvent.click(await screen.findByRole("button", { name: "Not you? Sign out" }));

    await waitFor(() => expect(location.href).toMatch(/^\/oauth\/continue\?/));
    expect(mocks.signOut).toHaveBeenCalled();
    const restarted = new URLSearchParams(location.href.split("?")[1]);
    expect(restarted.get("client_id")).toBe(QUERY.client_id);
    expect(restarted.get("sig")).toBe("signed");
  });

  it("tells the user they can close the tab when the assistant is a desktop app", async () => {
    searchParams = new URLSearchParams({ ...QUERY, redirect_uri: "cursor://cursor-mcp/callback" });
    stubSelection({ projectName: "mcp-e2e", workspaceName: null });
    mocks.consent.mockResolvedValue({ data: { url: "cursor://cursor-mcp/callback?code=x" } });
    render(<ConsentClient client={{ name: "Cursor", verifiedHost: "cursor.com" }} />);

    fireEvent.click(await screen.findByRole("button", { name: "Allow Cursor to read mcp-e2e" }));

    expect((await screen.findByRole("status")).textContent).toContain("You can close this tab");
  });
});
