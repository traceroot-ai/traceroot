// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ continue: vi.fn() }));

vi.mock("@/lib/auth-client", () => ({
  authClient: { oauth2: { continue: (...args: unknown[]) => mocks.continue(...args) } },
}));

import { SelectProjectClient, SEARCH_THRESHOLD } from "./select-project-client";

const CLAUDE = { name: "Claude", verifiedHost: "claude.ai" };

type Workspace = {
  id: string;
  name: string;
  role?: string;
  is_demo?: boolean;
  projects: { id: string; name: string }[];
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function stubWorkspaces(
  workspaces: Workspace[],
  extra?: (url: string, init?: RequestInit) => Response | undefined,
) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const handled = extra?.(url, init);
    if (handled) return handled;
    if (url === "/api/workspaces") return json({ workspaces });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

let location: { href: string; search: string };

beforeEach(() => {
  location = { href: "", search: "?client_id=c1&sig=s" };
  Object.defineProperty(window, "location", { value: location, configurable: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("SelectProjectClient", () => {
  it("groups projects under their workspace, naming each workspace once", async () => {
    stubWorkspaces([
      {
        id: "w1",
        name: "Acme",
        projects: [
          { id: "p2", name: "checkout" },
          { id: "p1", name: "billing" },
        ],
      },
      { id: "w2", name: "Side", projects: [{ id: "p3", name: "blog" }] },
      { id: "demo", name: "Demo", is_demo: true, projects: [{ id: "d1", name: "sample" }] },
    ]);
    render(<SelectProjectClient client={CLAUDE} />);

    const acme = await screen.findByRole("region", { name: "Acme" });
    expect(
      within(acme)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["billing", "checkout"]);
    expect(screen.getAllByText("Acme")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Side" })).toBeTruthy();
    expect(screen.queryByText("sample")).toBeNull();
    expect(screen.getByRole("heading", { name: "Choose a project for Claude" })).toBeTruthy();
  });

  it("marks the selected project and records it before continuing", async () => {
    const fetchMock = stubWorkspaces([
      {
        id: "w1",
        name: "Acme",
        projects: [
          { id: "p1", name: "billing" },
          { id: "p2", name: "checkout" },
        ],
      },
    ]);
    mocks.continue.mockResolvedValue({ data: { url: "/oauth/consent?x=1" }, error: null });
    render(<SelectProjectClient client={CLAUDE} />);

    const continueButton = await screen.findByRole("button", { name: "Continue" });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    const checkout = screen.getByRole("radio", { name: "checkout" });
    fireEvent.click(checkout);
    expect(checkout.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "billing" }).getAttribute("aria-checked")).toBe(
      "false",
    );

    fireEvent.click(continueButton);
    await waitFor(() => expect(location.href).toBe("/oauth/consent?x=1"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oauth/select-project",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ projectId: "p2" }) }),
    );
    expect(mocks.continue).toHaveBeenCalledWith({ postLogin: true });
  });

  it("offers search only past the threshold, and filters by it", async () => {
    const many = Array.from({ length: SEARCH_THRESHOLD + 1 }, (_, i) => ({
      id: `p${i}`,
      name: `project-${i}`,
    }));
    stubWorkspaces([{ id: "w1", name: "Acme", projects: many }]);
    render(<SelectProjectClient client={CLAUDE} />);

    const search = await screen.findByRole("searchbox", { name: "Search projects" });
    fireEvent.change(search, { target: { value: "project-3" } });
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toEqual(["project-3"]);
    cleanup();

    stubWorkspaces([{ id: "w1", name: "Acme", projects: many.slice(0, SEARCH_THRESHOLD) }]);
    render(<SelectProjectClient client={CLAUDE} />);
    await screen.findByRole("radio", { name: "project-0" });
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("creates a first project in place and selects it", async () => {
    let created = false;
    const fetchMock = stubWorkspaces([], (url, init) => {
      if (url === "/api/workspaces") {
        return json({
          workspaces: [
            {
              id: "w1",
              name: "Acme",
              role: "MEMBER",
              projects: created ? [{ id: "new", name: "agent" }] : [],
            },
          ],
        });
      }
      if (url === "/api/workspaces/w1/projects" && init?.method === "POST") {
        created = true;
        return json({ id: "new", name: "agent" }, 201);
      }
      return undefined;
    });
    render(<SelectProjectClient client={CLAUDE} />);

    fireEvent.change(await screen.findByRole("textbox", { name: "Project name" }), {
      target: { value: "agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const radio = await screen.findByRole("radio", { name: "agent" });
    expect(radio.getAttribute("aria-checked")).toBe("true");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/w1/projects",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "agent" }) }),
    );
  });

  it("sends a user with no workspace through setup and back to this authorization", async () => {
    stubWorkspaces([]);
    render(<SelectProjectClient client={CLAUDE} />);

    const link = await screen.findByRole("link", { name: "Set up a project" });
    expect(link.getAttribute("href")).toBe(
      `/onboarding?callbackUrl=${encodeURIComponent("/oauth/continue?client_id=c1&sig=s")}`,
    );
  });
});
