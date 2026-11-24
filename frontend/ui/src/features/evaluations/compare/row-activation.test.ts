// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { clickOpensRow } from "./row-activation";

/** A row holding a plain value, a tooltip-only label, and real controls. */
function row() {
  const table = document.createElement("table");
  table.innerHTML = `<tbody><tr tabindex="0"><td>
    <span id="text">Ticket 6</span>
    <span id="label" tabindex="0" data-tooltip-trigger>Task error</span>
    <button id="button"><svg id="icon"></svg></button>
    <a id="link" href="/somewhere">Open run</a>
    <span id="other" tabindex="0">Something focusable</span>
  </td></tr></tbody>`;
  const tr = table.querySelector("tr")!;
  const at = (id: string) => table.querySelector(`#${id}`)!;
  return { tr, at };
}

describe("clickOpensRow", () => {
  it("opens on plain text and on labels that only show a tooltip", () => {
    const { tr, at } = row();
    expect(clickOpensRow(tr, tr)).toBe(true);
    expect(clickOpensRow(at("text"), tr)).toBe(true);
    expect(clickOpensRow(at("label"), tr)).toBe(true);
  });

  it("leaves buttons, links and other focusable controls to act on their own", () => {
    const { tr, at } = row();
    expect(clickOpensRow(at("button"), tr)).toBe(false);
    expect(clickOpensRow(at("icon"), tr)).toBe(false);
    expect(clickOpensRow(at("link"), tr)).toBe(false);
    expect(clickOpensRow(at("other"), tr)).toBe(false);
  });

  it("opens from any line of a case's group, its focusable first line included", () => {
    const table = document.createElement("table");
    table.innerHTML = `<tbody>
      <tr tabindex="0" data-row="0"><td><span id="first">Ticket 6</span></td></tr>
      <tr><td><span id="second">run-2 output</span><button id="copy"></button></td></tr>
    </tbody>`;
    const group = table.querySelector("tbody")!;
    const at = (id: string) => table.querySelector(`#${id}`)!;
    expect(clickOpensRow(at("first"), group)).toBe(true);
    expect(clickOpensRow(table.querySelector("tr")!, group)).toBe(true);
    expect(clickOpensRow(at("second"), group)).toBe(true);
    expect(clickOpensRow(at("copy"), group)).toBe(false);
  });

  it("ignores a click from outside the row, such as a tooltip portalled out of it", () => {
    const { tr } = row();
    const tooltip = document.createElement("div");
    tooltip.textContent = "Upstream timeout";
    document.body.appendChild(tooltip);
    expect(clickOpensRow(tooltip, tr)).toBe(false);
    tooltip.remove();
  });
});
