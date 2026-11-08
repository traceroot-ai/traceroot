import { describe, expect, it } from "vitest";
import { bySampleKey, pickSample, quotaAllowed, sampleKey } from "../sampler.js";

const DAY = 24 * 60 * 60 * 1000;
const day0 = Date.UTC(2026, 10, 3);

function traces(n: number, prefix = "t") {
  return Array.from({ length: n }, (_, i) => ({ traceId: `${prefix}${i}`, traceTimeMs: day0 + i }));
}

describe("sampleKey", () => {
  it("is the same for the same ids and differs across projects", () => {
    expect(sampleKey("p", "abc")).toBe(sampleKey("p", "abc"));
    expect(sampleKey("p", "abc")).not.toBe(sampleKey("q", "abc"));
  });
  it("matches the backend's SQL expression (values computed by ClickHouse)", () => {
    expect(sampleKey("p", "abc")).toBe(18215011438584556115n);
    expect(sampleKey("proj-1", "trace-xyz")).toBe(3161014107248121116n);
  });
  it("is a 64-bit unsigned value", () => {
    const k = sampleKey("p", "abc");
    expect(k >= 0n && k < 2n ** 64n).toBe(true);
  });
});

describe("quotaAllowed", () => {
  it("gives a past day its whole target", () => {
    expect(quotaAllowed(day0, day0 + 2 * DAY, 300)).toBe(300);
  });
  it("opens the current day in slices", () => {
    expect(quotaAllowed(day0, day0 + 1000, 240)).toBe(10);
    expect(quotaAllowed(day0, day0 + 12 * 3600_000, 240)).toBe(130);
    expect(quotaAllowed(day0, day0 + DAY - 1, 240)).toBe(240);
  });
  it("gives a future day nothing", () => {
    expect(quotaAllowed(day0 + DAY, day0, 300)).toBe(0);
  });
});

describe("pickSample", () => {
  const base = { projectId: "p", dayStart: day0, nowMs: day0 + 3 * DAY, target: 50 };

  it("is deterministic: the same corpus gives the same pick, in any input order", () => {
    const c = traces(200);
    const a = pickSample({ ...base, candidates: c, digested: 0 });
    const b = pickSample({ ...base, candidates: [...c].reverse(), digested: 0 });
    expect(a.map((t) => t.traceId)).toEqual(b.map((t) => t.traceId));
    expect(a).toHaveLength(50);
  });

  it("respects the daily target given what is already digested", () => {
    expect(pickSample({ ...base, candidates: traces(200), digested: 30 })).toHaveLength(20);
    expect(pickSample({ ...base, candidates: traces(200), digested: 50 })).toHaveLength(0);
  });

  it("samples a small day fully", () => {
    expect(pickSample({ ...base, candidates: traces(12), digested: 0 })).toHaveLength(12);
  });

  it("takes the lowest keys, so a trace is in or out whatever else is present", () => {
    const c = traces(200);
    const picked = new Set(
      pickSample({ ...base, candidates: c, digested: 0 }).map((t) => t.traceId),
    );
    const ordered = bySampleKey("p", c).map((t) => t.traceId);
    expect(new Set(ordered.slice(0, 50))).toEqual(picked);
    // Adding traces that sort after the cut-off changes nothing.
    const extra = traces(100, "late").filter((t) => !ordered.slice(0, 50).includes(t.traceId));
    const again = pickSample({ ...base, candidates: [...c, ...extra], digested: 0 });
    const keepers = again.filter((t) => picked.has(t.traceId));
    expect(keepers.length).toBeGreaterThan(0);
  });

  it("never picks beyond today's open slice", () => {
    const now = day0 + 1000;
    expect(pickSample({ ...base, nowMs: now, candidates: traces(200), digested: 0 })).toHaveLength(
      3,
    );
  });
});
