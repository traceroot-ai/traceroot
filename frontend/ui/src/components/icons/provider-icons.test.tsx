// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ProviderIcon, MistralIcon } from "./provider-icons";

afterEach(cleanup);

describe("provider-icons", () => {
  it("renders MistralIcon directly", () => {
    const { container } = render(<MistralIcon className="h-5 w-5" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("class")).toContain("h-5 w-5");
    const path = container.querySelector("path");
    expect(path).toBeTruthy();
    expect(path?.getAttribute("d")).toContain("M17.143");
  });
  it("renders MistralIcon via ProviderIcon", () => {
    const { container } = render(<ProviderIcon adapter="mistral" className="h-4 w-4" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("class")).toContain("h-4 w-4");
    const path = container.querySelector("path");
    expect(path).toBeTruthy();
    expect(path?.getAttribute("d")).toContain("M17.143");
    expect(container.querySelector("circle")).toBeNull();
  });
});
