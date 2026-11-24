// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Delta } from "./cells";

describe("Delta", () => {
  it("renders a signed change", () => {
    const { container } = render(<Delta value={5} text="+5ms" direction="none" />);
    expect(container.textContent).toBe("+5ms");
  });

  it("renders nothing when the change rounded to an unsigned value", () => {
    const { container } = render(<Delta value={0.0004} text="0ms" direction="higher_is_better" />);
    expect(container.textContent).toBe("");
  });
});
