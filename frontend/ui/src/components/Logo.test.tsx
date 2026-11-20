// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Logo } from "./Logo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("Logo", () => {
  it("renders the wordmark with a light and a dark image, one visible per theme", () => {
    const imgs = render(<Logo />).querySelectorAll("img");
    expect([...imgs].map((i) => i.getAttribute("src"))).toEqual([
      "/images/traceroot_logo_light.png",
      "/images/traceroot_logo_dark.png",
    ]);
    expect(imgs[0].className).toContain("dark:hidden");
    expect(imgs[1].className).toContain("hidden dark:block");
  });

  it("is labelled for assistive tech once, with the images decorative", () => {
    const el = render(<Logo />);
    expect(el.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("TraceRoot");
    el.querySelectorAll("img").forEach((i) => expect(i.getAttribute("alt")).toBe(""));
  });

  it("mark variant crops the symbol out of the wordmark image", () => {
    const el = render(<Logo variant="mark" />);
    expect(el.querySelector("img")?.className).toContain("object-cover");
    expect(el.querySelector("img")?.className).toContain("object-left");
  });

  it("no longer draws the old tree mark", () => {
    expect(render(<Logo />).querySelector("svg")).toBeNull();
  });
});
