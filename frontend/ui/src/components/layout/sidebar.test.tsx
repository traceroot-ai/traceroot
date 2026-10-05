// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = { pathname: "/workspaces", params: {} as Record<string, string> };
let sessionData: {
  user: { role: string | null; name: string; email: string };
  session: { impersonatedBy?: string };
} | null = null;

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useParams: () => navigation.params,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: sessionData }),
    admin: { stopImpersonating: vi.fn() },
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn() }),
}));

// Children with their own data needs; covered by their own tests
vi.mock("@/components/layout/GitHubStarWidget", () => ({
  GitHubStarWidget: () => <div data-testid="star-widget" />,
}));
vi.mock("@/components/layout/SidebarUpgradeButton", () => ({
  SidebarUpgradeButton: () => <button data-testid="upgrade-button" />,
}));

import { Sidebar } from "@/components/layout/sidebar";

describe("Sidebar", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    navigation.pathname = "/workspaces";
    navigation.params = {};
    sessionData = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: { collapsed?: boolean } = {}) {
    act(() => {
      root.render(<Sidebar {...props} />);
    });
  }

  it("renders expanded at w-48 with the star widget above the bottom links", () => {
    process.env.NEXT_PUBLIC_APP_VERSION = "v1.2.3";
    render();

    const frame = container.querySelector("div.flex.h-screen");
    expect(frame?.className).toContain("w-48");
    expect(frame?.className).not.toContain("w-14");

    expect(container.querySelector('[data-testid="star-widget"]')).not.toBeNull();
    expect(container.textContent).toContain("Workspaces");
    expect(container.textContent).toContain("GitHub");
    expect(container.textContent).toContain("Support");
    expect(container.textContent).toContain("v1.2.3");
  });

  it("renders collapsed at w-14 and hides the star widget", () => {
    render({ collapsed: true });

    const frame = container.querySelector("div.flex.h-screen");
    expect(frame?.className).toContain("w-14");
    expect(frame?.className).not.toContain("w-48");
    expect(container.querySelector('[data-testid="star-widget"]')).toBeNull();
  });

  it("puts Home first among the project links, above Tracing", () => {
    navigation.pathname = "/projects/p1/home";
    navigation.params = { projectId: "p1" };
    render();

    const links = Array.from(container.querySelectorAll("nav a"));
    expect(links.slice(0, 2).map((l) => l.textContent)).toEqual(["Home", "Tracing"]);

    const home = links[0];
    expect(home.getAttribute("href")).toBe("/projects/p1/home");
    // Active state: the plain `bg-muted` token (not the `hover:` variant).
    expect(home.className.split(" ")).toContain("bg-muted");
    expect(links[1].className.split(" ")).not.toContain("bg-muted");
  });

  it("shows the upgrade button only in a project or workspace context", () => {
    render();
    expect(container.querySelector('[data-testid="upgrade-button"]')).toBeNull();

    navigation.pathname = "/projects/p1/traces";
    navigation.params = { projectId: "p1" };
    render();
    expect(container.querySelector('[data-testid="upgrade-button"]')).not.toBeNull();

    navigation.pathname = "/workspaces/w1";
    navigation.params = { workspaceId: "w1" };
    render();
    expect(container.querySelector('[data-testid="upgrade-button"]')).not.toBeNull();
  });

  it("renders nothing on auth pages", () => {
    navigation.pathname = "/auth/sign-in";
    render();
    expect(container.innerHTML).toBe("");
  });
  it.each(["admin", "support", null, "impersonated"])(
    "places the staff-only console in the account menu (%s)",
    (role) => {
      sessionData = {
        user: {
          role: role === "impersonated" ? "admin" : role,
          name: "Jared",
          email: "jared@local.dev",
        },
        session: { impersonatedBy: role === "impersonated" ? "staff" : undefined },
      };
      render();
      expect(container.querySelector('nav a[href="/admin"]')).toBeNull();
      expect(document.querySelector('a[href="/admin"]')).toBeNull();
      act(() =>
        (container.querySelector('[aria-label="Account menu"]') as HTMLButtonElement).click(),
      );
      const link = document.querySelector('a[href="/admin"]');
      expect(!!link).toBe(role === "admin" || role === "support");
      const sessions = document.querySelector('a[href="/account/settings/sessions"]');
      expect(sessions?.className).toContain("text-left");
      expect(sessions?.firstElementChild?.tagName.toLowerCase()).toBe("svg");
      if (link) {
        act(() => {
          link.addEventListener("click", (event) => event.preventDefault());
          (link as HTMLElement).click();
        });
        expect(document.querySelector('a[href="/admin"]')).toBeNull();
      }
    },
  );
});
