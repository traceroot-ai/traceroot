import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Slots } from "./slots";

describe("Slots", () => {
  it("puts the element where the text names it, wherever a translation moved it", () => {
    const name = <b>Acme</b>;
    expect(renderToStaticMarkup(<Slots text="Type {name} to confirm:" slots={{ name }} />)).toBe(
      "Type <b>Acme</b> to confirm:",
    );
    expect(renderToStaticMarkup(<Slots text="输入 {name} 以确认：" slots={{ name }} />)).toBe(
      "输入 <b>Acme</b> 以确认：",
    );
  });

  it("leaves a placeholder it has no element for as text", () => {
    expect(renderToStaticMarkup(<Slots text="Hello {who}" slots={{}} />)).toBe("Hello {who}");
    expect(renderToStaticMarkup(<Slots text="{toString}" slots={{}} />)).toBe("{toString}");
  });
});
