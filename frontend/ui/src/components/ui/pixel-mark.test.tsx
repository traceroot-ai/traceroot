// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PixelMark } from "./pixel-mark";

afterEach(cleanup);

describe("PixelMark", () => {
  it("is decorative and draws a 3x3 grid with some squares lit", () => {
    const { container } = render(<PixelMark />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const rects = [...svg.querySelectorAll("rect")];
    expect(rects).toHaveLength(9);
    expect(rects.filter((r) => r.getAttribute("opacity") === "1").length).toBeGreaterThan(0);
  });
});
