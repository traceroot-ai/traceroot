// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PixelField, PixelWordmark, YCBadge } from "./pixel-art";

afterEach(cleanup);

const asset = (name: string) =>
  readFileSync(resolve(__dirname, "../../../public/images", name), "utf8");

describe("PixelField", () => {
  it("draws the design's field from the top edge at its own proportions", () => {
    const { container } = render(<PixelField />);
    const field = container.firstElementChild as HTMLElement;
    expect(field.getAttribute("aria-hidden")).toBe("true");
    expect(field.className).toContain("bg-[url(/images/auth-pixel-field.svg)]");
    expect(field.className).toContain("aspect-[769/400]");
    expect(field.className).toContain("top-0");
  });

  it("ships the artwork at the size its classes assume", () => {
    expect(asset("auth-pixel-field.svg")).toMatch(/^<svg [^>]*viewBox="0 0 769 400"/);
  });
});

describe("PixelWordmark", () => {
  it("is an image named traceroot drawn from the design's wordmark", () => {
    const { getByRole } = render(<PixelWordmark />);
    const wordmark = getByRole("img", { name: "traceroot" });
    expect(wordmark.className).toContain("bg-[url(/images/auth-pixel-wordmark.svg)]");
    expect(wordmark.className).toContain("aspect-[538/76]");
  });

  it("ships the artwork at the size its classes assume", () => {
    expect(asset("auth-pixel-wordmark.svg")).toMatch(/^<svg [^>]*viewBox="0 0 538 76"/);
  });
});

describe("YCBadge", () => {
  it("names Y Combinator", () => {
    const { getByText } = render(<YCBadge />);
    expect(getByText("Backed by Y Combinator")).toBeTruthy();
  });
});
