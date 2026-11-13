// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const wordmark = vi.hoisted(() => ({ mount: vi.fn(), dispose: vi.fn() }));

vi.mock("./footer-wordmark.runtime.js", () => {
  (globalThis as Record<string, unknown>).TraceRootFooterWordmark = {
    mountFooterWordmark: (canvas: HTMLCanvasElement) => {
      wordmark.mount(canvas);
      return wordmark.dispose;
    },
  };
  return {};
});

import { PixelField, PixelWordmark, YCBadge } from "./pixel-art";

const FACES = ["#9ee1db", "#2fbdb3", "#0f827d"];
const ACCENT = "#14b8b0";

type Fill = { style: string; alpha: number; x: number; y: number };

let fills: Fill[];
let nextFrame: FrameRequestCallback | null;
let onVisibility: (entries: { isIntersecting: boolean }[]) => void;
let onMotion: () => void;
let onResize: () => void;
let reduceMotion: boolean;
let size: { width: number; height: number };
const disconnects = { intersection: vi.fn(), resize: vi.fn() };

function fakeContext() {
  const ctx = {
    globalAlpha: 1,
    fillStyle: "",
    clearRect: () => (fills = []),
    setTransform: vi.fn(),
    fillRect: (x: number, y: number) =>
      fills.push({ style: String(ctx.fillStyle), alpha: ctx.globalAlpha, x, y }),
  };
  return ctx;
}

function runFrame(now: number) {
  const frame = nextFrame;
  nextFrame = null;
  frame?.(now);
}

beforeEach(() => {
  fills = [];
  nextFrame = null;
  reduceMotion = false;
  size = { width: 800, height: 900 };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => fakeContext() as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ ...size }) as DOMRect,
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    nextFrame = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => (nextFrame = null));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: typeof onVisibility) {
        onVisibility = cb;
      }
      observe() {
        onVisibility([{ isIntersecting: true }]);
      }
      disconnect = disconnects.intersection;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        onResize = cb;
      }
      observe() {}
      disconnect = disconnects.resize;
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reduceMotion;
    },
    addEventListener: (_: string, handler: () => void) => (onMotion = handler),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PixelField", () => {
  it("draws the three cube faces and the share-image field", () => {
    render(<PixelField />);
    runFrame(0);
    const styles = new Set(fills.map((f) => f.style));
    for (const face of FACES) expect(styles).toContain(face);
    const field = fills.filter((f) => f.style === ACCENT);
    expect(field.length).toBeGreaterThan(0);
    // The field rises from the bottom: none of it reaches the top third.
    expect(Math.min(...field.map((f) => f.y))).toBeGreaterThan(size.height / 3);
  });

  it("keeps the field to the bottom edge on narrow panels", () => {
    size = { width: 390, height: 232 };
    render(<PixelField />);
    runFrame(0);
    const field = fills.filter((f) => f.style === ACCENT);
    expect(field.length).toBeGreaterThan(0);
    expect(Math.min(...field.map((f) => f.y))).toBeGreaterThanOrEqual(232 - 5 * 8);
  });

  it("sweeps comets across the field and wraps them back to the left", () => {
    size = { width: 40, height: 40 };
    render(<PixelField />);
    let swept = false;
    for (let i = 0; i < 60; i++) {
      runFrame(i * 50);
      swept ||= fills.some((f) => f.style === "#0f827d" && f.alpha < 1);
    }
    expect(swept).toBe(true);
  });

  it("draws one still frame and stops under reduced motion", () => {
    reduceMotion = true;
    render(<PixelField />);
    runFrame(0);
    expect(fills.length).toBeGreaterThan(0);
    expect(nextFrame).toBeNull();
    expect(fills.some((f) => f.style === "#0f827d" && f.alpha < 1)).toBe(false);
  });

  // Resizing clears the canvas; a still frame would otherwise stay blank.
  it("repaints a still frame after a resize", () => {
    reduceMotion = true;
    render(<PixelField />);
    runFrame(0);
    size = { width: 600, height: 700 };
    onResize();
    fills = [];
    runFrame(16);
    expect(fills.length).toBeGreaterThan(0);
  });

  it("restarts when the motion preference changes", () => {
    reduceMotion = true;
    render(<PixelField />);
    runFrame(0);
    reduceMotion = false;
    onMotion();
    expect(nextFrame).not.toBeNull();
  });

  it("pauses offscreen and cleans up on unmount", () => {
    const { unmount } = render(<PixelField />);
    onVisibility([{ isIntersecting: false }]);
    expect(nextFrame).toBeNull();
    unmount();
    expect(disconnects.intersection).toHaveBeenCalled();
    expect(disconnects.resize).toHaveBeenCalled();
  });

  it("waits for a size before drawing", () => {
    size = { width: 0, height: 0 };
    render(<PixelField />);
    runFrame(0);
    expect(fills).toHaveLength(0);
  });
});

describe("PixelWordmark", () => {
  it("mounts the docs footer runtime on its canvas and disposes it on unmount", async () => {
    const { getByRole, unmount } = render(<PixelWordmark />);
    const canvas = getByRole("img", { name: "traceroot" });
    await waitFor(() => expect(wordmark.mount).toHaveBeenCalledWith(canvas));
    expect(canvas.style.getPropertyValue("--wm-ink")).toBe(ACCENT);
    unmount();
    expect(wordmark.dispose).toHaveBeenCalled();
  });
});

describe("YCBadge", () => {
  it("names Y Combinator", () => {
    const { getByText } = render(<YCBadge />);
    expect(getByText("Backed by Y Combinator")).toBeTruthy();
  });
});

describe("footer wordmark runtime", () => {
  // The app and the docs footer must run the same generated animation; update both from
  // traceroot-website's export script (see docs/brand/README.md), never by hand.
  it("matches the docs snapshot byte for byte", () => {
    const app = readFileSync(resolve(__dirname, "footer-wordmark.runtime.js"));
    const docs = readFileSync(
      resolve(__dirname, "../../../../../docs/brand/footer-wordmark.runtime.js"),
    );
    expect(app.equals(docs)).toBe(true);
  });
});
