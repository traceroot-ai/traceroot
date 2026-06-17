import { describe, it, expect } from "vitest";
import { describeRcaStatus } from "./use-findings";

describe("describeRcaStatus — the Agent analysis column vocabulary", () => {
  it("renders an em dash when the field is absent (enrichment unavailable)", () => {
    const p = describeRcaStatus(undefined);
    expect(p.label).toBe("—");
    expect(p.title).toBeUndefined();
  });

  it("renders Skipped with an explanatory tooltip when no RCA row exists", () => {
    const p = describeRcaStatus(null);
    expect(p.label).toBe("Skipped");
    expect(p.title).toMatch(/off for the detector/i);
    expect(p.className).toContain("text-muted-foreground");
  });

  it("renders Done for a completed analysis", () => {
    expect(describeRcaStatus("done")).toEqual({
      label: "Done",
      className: "text-foreground",
    });
  });

  it("renders Failed in destructive styling", () => {
    const p = describeRcaStatus("failed");
    expect(p.label).toBe("Failed");
    expect(p.className).toContain("text-destructive");
  });

  it("renders Running… for both pending and running (in-flight states)", () => {
    expect(describeRcaStatus("pending").label).toBe("Running…");
    expect(describeRcaStatus("running").label).toBe("Running…");
  });

  it("falls back to the raw value for an unrecognized future status", () => {
    // Guards against a new worker status (e.g. "canceled") silently rendering
    // as Running… forever.
    const p = describeRcaStatus("canceled" as never);
    expect(p.label).toBe("canceled");
    expect(p.title).toBeUndefined();
  });
});
