import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("./client", () => ({ fetchTraceApi: vi.fn().mockResolvedValue({}) }));

import { fetchTraceApi } from "./client";
import { getTrace, isCustomerTraffic, type TraceSource } from "./traces";

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

describe("isCustomerTraffic", () => {
  it("is true for user traffic and for an omitted source, which reads as customer", () => {
    expect(isCustomerTraffic("user")).toBe(true);
    expect(isCustomerTraffic(undefined)).toBe(true);
    expect(isCustomerTraffic()).toBe(true);
  });

  it("is false for every internal source", () => {
    expect(isCustomerTraffic("detector")).toBe(false);
    expect(isCustomerTraffic("agent")).toBe(false);
  });

  it("fails closed for a source it has never seen", () => {
    // Stands in for an internal source added to TraceSource later: the rule names
    // "user", so the new value must land on the internal side without anyone
    // revisiting this function.
    expect(isCustomerTraffic("assistant" as TraceSource)).toBe(false);
  });
});

describe("the trace viewer asks through isCustomerTraffic", () => {
  // Asserted over source text: the failure this guards is a call site going back to
  // listing internal sources inline, which a runtime test of the helper cannot see.
  const panel = readFileSync(
    join(__dirname, "../../features/traces/components/TraceViewerPanel.tsx"),
    "utf8",
  );

  it("spells out no list of internal sources", () => {
    expect(panel).not.toMatch(/source\s*===\s*"detector"/);
    expect(panel).not.toMatch(/source\s*!==\s*"user"/);
  });

  it("uses the shared check", () => {
    expect(panel).toMatch(/isCustomerTraffic\(source\)/);
  });
});
