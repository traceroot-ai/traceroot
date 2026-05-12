import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AI_RUN_QUOTAS,
  RCA_RUN_QUOTAS,
  DETECTOR_RUN_QUOTAS,
  PlanType,
  isAiRunBlocked,
  isRcaRunBlocked,
  isDetectorRunBlocked,
} from "../plans.js";

describe("RCA_RUN_QUOTAS", () => {
  it("mirrors AI_RUN_QUOTAS shape and values per resolved decision", () => {
    expect(RCA_RUN_QUOTAS[PlanType.FREE].included).toBe(30);
    expect(RCA_RUN_QUOTAS[PlanType.STARTER].included).toBe(100);
    expect(RCA_RUN_QUOTAS[PlanType.PRO].included).toBe(100);
    expect(RCA_RUN_QUOTAS[PlanType.ENTERPRISE].included).toBe(Infinity);
  });

  it("Starter and Pro share quota (parity rule)", () => {
    expect(RCA_RUN_QUOTAS[PlanType.STARTER].included).toBe(RCA_RUN_QUOTAS[PlanType.PRO].included);
    expect(RCA_RUN_QUOTAS[PlanType.STARTER].overageLabel).toBe(
      RCA_RUN_QUOTAS[PlanType.PRO].overageLabel,
    );
  });
});

describe("RCA vs AI quota separation", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_BILLING", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("free plan: RCA usage does not count against AI run quota", () => {
    expect(isAiRunBlocked(PlanType.FREE, 0)).toBe(false);
    expect(isRcaRunBlocked(PlanType.FREE, 30)).toBe(true);
  });

  it("free plan: AI usage does not count against RCA quota", () => {
    expect(isRcaRunBlocked(PlanType.FREE, 0)).toBe(false);
    expect(isAiRunBlocked(PlanType.FREE, 30)).toBe(true);
  });

  it("paid plans: never hard-block on either meter", () => {
    expect(isAiRunBlocked(PlanType.STARTER, 9999)).toBe(false);
    expect(isRcaRunBlocked(PlanType.STARTER, 9999)).toBe(false);
    expect(isAiRunBlocked(PlanType.PRO, 9999)).toBe(false);
    expect(isRcaRunBlocked(PlanType.PRO, 9999)).toBe(false);
    expect(isAiRunBlocked(PlanType.ENTERPRISE, 99999)).toBe(false);
    expect(isRcaRunBlocked(PlanType.ENTERPRISE, 99999)).toBe(false);
  });
});

describe("DETECTOR_RUN_QUOTAS", () => {
  it("Free has a 100-scan hard cap; paid plans are unlimited", () => {
    expect(DETECTOR_RUN_QUOTAS[PlanType.FREE].included).toBe(100);
    expect(DETECTOR_RUN_QUOTAS[PlanType.STARTER].included).toBe(Infinity);
    expect(DETECTOR_RUN_QUOTAS[PlanType.PRO].included).toBe(Infinity);
    expect(DETECTOR_RUN_QUOTAS[PlanType.ENTERPRISE].included).toBe(Infinity);
  });
});

describe("isDetectorRunBlocked", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_BILLING", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Free: blocked at exactly 100 scans (hard cap)", () => {
    expect(isDetectorRunBlocked(PlanType.FREE, 0)).toBe(false);
    expect(isDetectorRunBlocked(PlanType.FREE, 99)).toBe(false);
    expect(isDetectorRunBlocked(PlanType.FREE, 100)).toBe(true);
    expect(isDetectorRunBlocked(PlanType.FREE, 5000)).toBe(true);
  });

  it("Paid plans: never blocked", () => {
    expect(isDetectorRunBlocked(PlanType.STARTER, 100_000)).toBe(false);
    expect(isDetectorRunBlocked(PlanType.PRO, 100_000)).toBe(false);
    expect(isDetectorRunBlocked(PlanType.ENTERPRISE, 100_000)).toBe(false);
  });

  it("respects ENABLE_BILLING=false (unblocks all)", () => {
    vi.stubEnv("ENABLE_BILLING", "false");
    expect(isDetectorRunBlocked(PlanType.FREE, 9999)).toBe(false);
  });
});
