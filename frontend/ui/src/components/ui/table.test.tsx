// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LIST_TABLE_MIN_WIDTH, Table } from "./table";

afterEach(cleanup);

describe("Table", () => {
  it("keeps a minimum width so narrow screens scroll instead of crushing columns", () => {
    const { container } = render(<Table />);
    expect(container.querySelector("table")?.className).toContain(LIST_TABLE_MIN_WIDTH);
  });

  it("lets a caller widen it", () => {
    const { container } = render(<Table className="min-w-[72rem]" />);
    expect(container.querySelector("table")?.className).toContain("min-w-[72rem]");
    expect(container.querySelector("table")?.className).not.toContain("min-w-[48rem]");
  });
});

import { IdCell, TruncCell, TD, TH } from "./table";

describe("table cells", () => {
  it("draw no vertical dividers and keep one row height", () => {
    for (const cls of [TH, TD]) {
      expect(cls).not.toContain("border-r");
      expect(cls).toContain("h-9");
      expect(cls).toContain("whitespace-nowrap");
    }
  });

  it("IdCell truncates to a fixed width and keeps the full id on hover", () => {
    const { container } = render(<IdCell id="1a2edc4f-6211-4a7b-9c8d-abcdef311433" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("truncate");
    expect(el.className).toContain("w-[9ch]");
    expect(el.getAttribute("title")).toBe("1a2edc4f-6211-4a7b-9c8d-abcdef311433");
  });

  it("TruncCell is one line with the full text as its title", () => {
    const { container } = render(<TruncCell>A very long signal name</TruncCell>);
    const el = container.firstElementChild as HTMLElement;
    expect(el.className).toContain("truncate");
    expect(el.getAttribute("title")).toBe("A very long signal name");
  });
});
