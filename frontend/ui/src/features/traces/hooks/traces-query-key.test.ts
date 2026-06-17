import { describe, it, expect } from "vitest";
import { tracesQueryKey } from "./index";

describe("tracesQueryKey", () => {
  it("includes project id and all paging/filter fields in a stable order", () => {
    expect(
      tracesQueryKey("p1", {
        page: 2,
        limit: 50,
        search_query: "x",
        start_after: "S",
        end_before: "E",
        user_id: "u",
        session_id: "s",
      }),
    ).toEqual(["traces", "p1", 2, 50, "x", "S", "E", "u", "s"]);
  });

  it("fills undefined for omitted options so keys stay positionally stable", () => {
    expect(tracesQueryKey("p1", { page: 0, limit: 50 })).toEqual([
      "traces",
      "p1",
      0,
      50,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
