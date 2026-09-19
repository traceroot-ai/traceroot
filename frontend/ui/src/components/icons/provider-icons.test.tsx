// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LLMAdapter } from "@traceroot/core/llm-providers";
import { ProviderIcon } from "./provider-icons";

afterEach(cleanup);

const ADAPTERS = Object.values(LLMAdapter);

/** The letter-circle fallback is the only mark rendered with a <text> node. */
function isFallback(container: HTMLElement): boolean {
  return container.querySelector("text") !== null;
}

describe("ProviderIcon", () => {
  it("covers every supported adapter with a real brand mark", () => {
    // Guards the registry against drift: a new LLMAdapter with no icon would
    // otherwise degrade silently to the letter-circle in the settings UI.
    const missing = ADAPTERS.filter((adapter) => {
      const { container } = render(<ProviderIcon adapter={adapter} />);
      return isFallback(container);
    });

    expect(missing).toEqual([]);
  });

  it.each(ADAPTERS)("renders %s without a hard-coded black fill", (adapter) => {
    const { container } = render(<ProviderIcon adapter={adapter} />);
    const svg = container.querySelector("svg");

    expect(svg).not.toBeNull();

    // A monochrome mark painted pure black is invisible in dark mode. Marks
    // that intentionally carry their own background tile are exempt, since the
    // black is the tile rather than the glyph.
    const hasOwnTile = svg!.querySelector("rect") !== null;
    if (hasOwnTile) return;

    const blackFills = Array.from(svg!.querySelectorAll("[fill]")).filter((el) => {
      const fill = el.getAttribute("fill")?.toLowerCase();
      return fill === "#000" || fill === "#000000" || fill === "black";
    });

    expect(blackFills).toEqual([]);
  });

  it("falls back to a letter circle for an unknown adapter", () => {
    const { container } = render(<ProviderIcon adapter="not-a-provider" />);

    expect(isFallback(container)).toBe(true);
    expect(container.querySelector("text")?.textContent).toBe("N");
  });

  it("matches adapters case-insensitively", () => {
    const { container } = render(<ProviderIcon adapter="OpenAI" />);

    expect(isFallback(container)).toBe(false);
  });

  it("forwards className onto the rendered svg", () => {
    const { container } = render(<ProviderIcon adapter="anthropic" className="h-6 w-6" />);

    expect(container.querySelector("svg")?.getAttribute("class")).toContain("h-6");
  });
});
