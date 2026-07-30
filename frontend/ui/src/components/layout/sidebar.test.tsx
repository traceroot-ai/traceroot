// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const navigation = { pathname: "/workspaces", params: {} as Record<string, string> };

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useParams: () => navigation.params,
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null }),
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
});
