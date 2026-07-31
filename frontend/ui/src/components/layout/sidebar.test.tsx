// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent, screen, waitFor } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Radix DropdownMenu opens on pointerdown and relies on pointer-capture APIs
// jsdom doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

const navigation = { pathname: "/workspaces", params: {} as Record<string, string> };

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useParams: () => navigation.params,
}));

const mocks = vi.hoisted(() => ({
  theme: "light" as string | undefined,
  setTheme: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null }),
    admin: { stopImpersonating: vi.fn() },
    signOut: (...args: unknown[]) => mocks.signOut(...args),
  },
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: mocks.theme, setTheme: mocks.setTheme }),
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

  describe("account menu", () => {
    beforeEach(() => {
      mocks.theme = "light";
      mocks.setTheme.mockClear();
      mocks.signOut.mockClear();
      Object.defineProperty(window, "location", {
        writable: true,
        configurable: true,
        value: { href: "" },
      });
    });

    async function openAccountMenu() {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu" }), {
        button: 0,
        pointerType: "mouse",
      });
      await screen.findByRole("menu");
    }

    it("shows left-aligned Light/Dark/System items with the active theme checked", async () => {
      render();
      await openAccountMenu();

      const items = screen.getAllByRole("menuitemradio");
      expect(items.map((el) => el.textContent)).toEqual(["Light", "Dark", "System"]);
      items.forEach((el) => expect(el.className).not.toContain("justify-center"));

      expect(items[0].getAttribute("aria-checked")).toBe("true");
      expect(items[1].getAttribute("aria-checked")).toBe("false");
      expect(items[2].getAttribute("aria-checked")).toBe("false");
    });

    it("calls setTheme when picking a different theme, without closing the menu", async () => {
      render();
      await openAccountMenu();

      fireEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));

      expect(mocks.setTheme).toHaveBeenCalledWith("dark");
      expect(screen.getByRole("menu")).toBeTruthy();
    });

    it("defaults to System checked when no theme is set yet", async () => {
      mocks.theme = undefined;
      render();
      await openAccountMenu();

      expect(
        screen.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked"),
      ).toBe("true");
    });

    it("shows Log Out with an icon, separated by a divider, styled as destructive, and signs out on click", async () => {
      render();
      await openAccountMenu();

      expect(screen.getByRole("separator")).toBeTruthy();

      const logOut = screen.getByRole("menuitem", { name: /Log Out/i });
      expect(logOut.className).not.toContain("justify-center");
      expect(logOut.className).toContain("text-red-600");
      expect(logOut.querySelector("svg")).toBeTruthy();

      fireEvent.click(logOut);

      expect(mocks.signOut).toHaveBeenCalled();
      await waitFor(() => expect(window.location.href).toBe("/auth/sign-in"));
    });
  });
});
