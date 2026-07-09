import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./client", () => ({ fetchTraceApi: vi.fn().mockResolvedValue({ fields: [] }) }));

import { fetchTraceApi } from "./client";
import { getFilterFields, getFilterValues } from "./traces";

const mockFetch = vi.mocked(fetchTraceApi);

beforeEach(() => mockFetch.mockClear());

describe("filter meta API", () => {
  it("getFilterFields hits the filter-fields endpoint", async () => {
    await getFilterFields("p1");
    expect(mockFetch.mock.calls[0][0]).toBe("/projects/p1/traces/filter-fields");
  });

  it("getFilterValues encodes the field and omits the query when no window", async () => {
    await getFilterValues("p1", "model_name", undefined, undefined);
    expect(mockFetch.mock.calls[0][0]).toBe("/projects/p1/traces/filter-values/model_name");
  });

  it("getFilterValues appends an encoded start_after when present", async () => {
    await getFilterValues("p1", "model_name", "2026-06-01T00:00:00Z", undefined);
    expect(mockFetch.mock.calls[0][0]).toBe(
      "/projects/p1/traces/filter-values/model_name?start_after=2026-06-01T00%3A00%3A00Z",
    );
  });

  it("getFilterValues appends both bounds so options match the active window", async () => {
    await getFilterValues("p1", "model_name", "2026-06-01T00:00:00Z", "2026-06-02T00:00:00Z");
    expect(mockFetch.mock.calls[0][0]).toBe(
      "/projects/p1/traces/filter-values/model_name" +
        "?start_after=2026-06-01T00%3A00%3A00Z&end_before=2026-06-02T00%3A00%3A00Z",
    );
  });
});
