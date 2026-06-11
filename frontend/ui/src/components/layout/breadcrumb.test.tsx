// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { Breadcrumb, type BreadcrumbItem } from "@/components/layout/breadcrumb";

beforeAll(() => {
  // jsdom lacks these; Radix menus call them on focus / pointer handling.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => cleanup());

const workspaceItem: BreadcrumbItem = {
  label: "Workspace One",
  options: [
    { id: "ws-1", label: "Workspace One", href: "/workspaces/ws-1/projects" },
    { id: "ws-2", label: "Workspace Two", href: "/workspaces/ws-2/projects" },
  ],
  menuHeader: { label: "Workspaces", href: "/workspaces" },
};

function renderAndOpen() {
  render(<Breadcrumb items={[workspaceItem]} />);
  const trigger = screen.getByRole("button");
  // Radix triggers open on pointerdown, not click.
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  return trigger;
}

describe("BreadcrumbDropdown focus return", () => {
  it("does not refocus the trigger when an entry is selected with the mouse", async () => {
    const trigger = renderAndOpen();
    const entry = await screen.findByText("Workspace Two");
    fireEvent.pointerDown(entry, { button: 0, pointerType: "mouse" });
    fireEvent.click(entry);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).not.toBe(trigger);
  });

  it("refocuses the trigger when the menu is closed with the keyboard", async () => {
    const trigger = renderAndOpen();
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("refocuses the trigger when the menu is opened and closed with the keyboard", async () => {
    render(<Breadcrumb items={[workspaceItem]} />);
    const trigger = screen.getByRole("button");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
