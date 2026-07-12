// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ProviderIcon, GroqIcon } from "./provider-icons";

describe("ProviderIcon", () => {
  it("renders GroqIcon when adapter is groq", () => {
    const { container } = render(<ProviderIcon adapter="groq" />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders GroqIcon directly", () => {
    const { container } = render(<GroqIcon />);
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
