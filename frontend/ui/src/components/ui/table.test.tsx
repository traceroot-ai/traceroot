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
