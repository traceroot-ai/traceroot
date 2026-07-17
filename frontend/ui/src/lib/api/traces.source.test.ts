import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./client", () => ({ fetchTraceApi: vi.fn().mockResolvedValue({}) }));

import { fetchTraceApi } from "./client";
import { getTrace } from "./traces";

describe("getTrace source scoping", () => {
  beforeEach(() => {
    vi.mocked(fetchTraceApi).mockClear();
  });

  it("appends ?source= when a source is given", async () => {
    await getTrace("p-1", "t-1", "", undefined, "detector");
    expect(vi.mocked(fetchTraceApi).mock.calls[0][0]).toBe(
      "/projects/p-1/traces/t-1?source=detector",
    );
  });

  it("leaves the path bare when no source is given", async () => {
    await getTrace("p-1", "t-1", "");
    expect(vi.mocked(fetchTraceApi).mock.calls[0][0]).toBe("/projects/p-1/traces/t-1");
  });
});
