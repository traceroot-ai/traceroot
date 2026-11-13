import { describe, expect, it } from "vitest";
import { listReturnHrefWithDateWindow, withDateWindow } from "./use-list-return";

describe("withDateWindow", () => {
  it("replaces the date window and keeps everything else", () => {
    expect(withDateWindow("page_index=2&date_filter=30d", "/x?date_filter=7d")).toBe(
      "page_index=2&date_filter=7d",
    );
  });

  it("drops custom bounds when the new window is a preset", () => {
    expect(
      withDateWindow(
        "date_filter=custom&start=2026-01-01T00%3A00%3A00.000Z&end=2026-01-02T00%3A00%3A00.000Z",
        "/x?date_filter=7d",
      ),
    ).toBe("date_filter=7d");
  });
});

describe("listReturnHrefWithDateWindow", () => {
  const list = "/projects/p1/detectors";

  it("keeps the page when the same custom range was clamped a few ms apart", () => {
    // Each page clamps a start older than retention to "now - retention" on its own,
    // so the list and the detector page carry the same range with different ms.
    expect(
      listReturnHrefWithDateWindow(
        `${list}?page_index=2&date_filter=custom&start=2026-09-24T10%3A00%3A00.102Z&end=2026-10-01T00%3A00%3A00.000Z`,
        `${list}?date_filter=custom&start=2026-09-24T10%3A00%3A00.110Z&end=2026-10-01T00%3A00%3A00.000Z`,
      ),
    ).toBe(
      `${list}?page_index=2&date_filter=custom&start=2026-09-24T10%3A00%3A00.110Z&end=2026-10-01T00%3A00%3A00.000Z`,
    );
  });

  it("falls back to the dated list link when the list recorded nothing", () => {
    expect(listReturnHrefWithDateWindow(list, `${list}?date_filter=7d`)).toBe(
      `${list}?date_filter=7d`,
    );
  });

  it("keeps the list's page when the range is unchanged", () => {
    expect(
      listReturnHrefWithDateWindow(
        `${list}?page_index=2&page_limit=100&date_filter=7d`,
        `${list}?date_filter=7d`,
      ),
    ).toBe(`${list}?page_index=2&page_limit=100&date_filter=7d`);
  });

  it("carries a changed range back, keeping the page, page size and filters", () => {
    const filters = encodeURIComponent('[{"field":"name","op":"in","value":["a"]}]');
    expect(
      listReturnHrefWithDateWindow(
        `${list}?page_index=2&page_limit=100&filters=${filters}&date_filter=30d`,
        `${list}?date_filter=custom&start=2026-01-01T00%3A00%3A00.000Z&end=2026-01-02T00%3A00%3A00.000Z`,
      ),
    ).toBe(
      `${list}?page_index=2&page_limit=100&filters=${filters}&date_filter=custom&start=2026-01-01T00%3A00%3A00.000Z&end=2026-01-02T00%3A00%3A00.000Z`,
    );
  });
});
