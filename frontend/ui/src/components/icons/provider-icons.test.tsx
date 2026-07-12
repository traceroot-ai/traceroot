// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { GroqIcon, ProviderIcon } from "./provider-icons";

afterEach(cleanup);

describe("GroqIcon", () => {
  it("renders an svg with a path", () => {
    const { container } = render(<GroqIcon />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.querySelector("path")).not.toBeNull();
  });

  it("applies a custom className alongside the defaults", () => {
    const { container } = render(<GroqIcon className="text-red-500" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("text-red-500");
  });
});

describe("ProviderIcon", () => {
  it("renders the Groq icon for the groq adapter", () => {
    const { container } = render(<ProviderIcon adapter="groq" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    // The mapped Groq icon draws a path (the fallback would render a <text> letter).
    expect(svg?.querySelector("path")).not.toBeNull();
    expect(svg?.querySelector("text")).toBeNull();
  });

  it("resolves the adapter case-insensitively", () => {
    const { container } = render(<ProviderIcon adapter="GROQ" />);
    expect(container.querySelector("svg path")).not.toBeNull();
    expect(container.querySelector("svg text")).toBeNull();
  });

  it("falls back to a lettered circle for an unknown adapter", () => {
    const { container } = render(<ProviderIcon adapter="unknown-provider" />);
    const svg = container.querySelector("svg");
    expect(svg?.querySelector("circle")).not.toBeNull();
    expect(svg?.querySelector("text")?.textContent).toBe("U");
  });
});
