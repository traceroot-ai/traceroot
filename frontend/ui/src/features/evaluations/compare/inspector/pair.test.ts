import { describe, expect, it } from "vitest";
import { BASELINE_RUN, CANDIDATE_RUN, FAST_RUN, PAIRED_FIXTURE } from "../__tests__/paired-fixture";
import { buildCompareModel } from "../model";
import { openingCandidate, resolvePair } from "./pair";

const model = buildCompareModel(PAIRED_FIXTURE, null);
const BASE = BASELINE_RUN.id;
const CAND = CANDIDATE_RUN.id;
const FAST = FAST_RUN.id;

describe("openingCandidate", () => {
  it("is the run whose value was clicked", () => {
    expect(openingCandidate(model, FAST, CAND)).toBe(FAST);
  });

  it("is the last candidate shown when the click names no run, or names the baseline", () => {
    expect(openingCandidate(model, null, FAST)).toBe(FAST);
    expect(openingCandidate(model, BASE, FAST)).toBe(FAST);
  });

  it("is the first run after the baseline otherwise", () => {
    expect(openingCandidate(model, null, null)).toBe(CAND);
    // A last candidate that is now the baseline, or no longer compared, doesn't count.
    expect(openingCandidate(model, null, BASE)).toBe(CAND);
    expect(openingCandidate(model, "run-gone", "run-gone")).toBe(CAND);
  });

  it("follows the table's baseline", () => {
    const fromCandidate = buildCompareModel(PAIRED_FIXTURE, CAND);
    expect(openingCandidate(fromCandidate, null, null)).toBe(BASE);
    expect(openingCandidate(fromCandidate, CAND, null)).toBe(BASE);
  });

  it("is nothing without a second run", () => {
    expect(openingCandidate(buildCompareModel([PAIRED_FIXTURE[2]], null), null, null)).toBeNull();
  });
});

describe("resolvePair", () => {
  it("keeps a requested pair of two compared runs, in either order", () => {
    expect(resolvePair(model, [CAND, BASE], null)).toEqual([CAND, BASE]);
    expect(resolvePair(model, [FAST, CAND], null)).toEqual([FAST, CAND]);
  });

  it("falls back to the table's baseline and the opening candidate", () => {
    expect(resolvePair(model, null, null)).toEqual([BASE, CAND]);
    expect(resolvePair(model, null, FAST)).toEqual([BASE, FAST]);
    expect(resolvePair(model, ["run-gone", CAND], null)).toEqual([BASE, CAND]);
    expect(resolvePair(model, [CAND, CAND], null)).toEqual([BASE, CAND]);
  });

  it("is nothing without a second run", () => {
    expect(resolvePair(buildCompareModel([PAIRED_FIXTURE[2]], null), null, null)).toBeNull();
  });
});
