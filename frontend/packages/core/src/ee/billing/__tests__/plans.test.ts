import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AI_RUN_QUOTAS,
  RCA_RUN_QUOTAS,
  DETECTOR_RUN_QUOTAS,
  USAGE_CONFIG,
  PlanType,
  isAiRunBlocked,
  isRcaRunBlocked,
  isDetectorRunBlocked,
  isIngestionBlocked,
  hasEntitlement,
  countCurrentSeats,
} from "../plans.ts";

describe("countCurrentSeats", () => {
  it("sums members and pending invites", () => {
    expect(countCurrentSeats({ members: 2, invites: 3 })).toBe(5);
  });

  it("subtracts one when the operation supersedes an invite", () => {
    expect(countCurrentSeats({ members: 2, invites: 3 }, { supersedesInvite: true })).toBe(4);
  });

  it("does not go negative when invites is already zero and supersedesInvite is true", () => {
    // Callers only pass supersedesInvite: true when they already found a
    // matching invite, so invites >= 1 in practice, but the math itself
    // shouldn't silently clamp — this documents the (unreachable in
    // practice) edge rather than hiding it.
    expect(countCurrentSeats({ members: 2, invites: 0 }, { supersedesInvite: true })).toBe(1);
  });
});

describe("slack-integration entitlement", () => {
  it("is available on every plan (free tier included)", () => {
    expect(hasEntitlement(PlanType.FREE, "slack-integration")).toBe(true);
    expect(hasEntitlement(PlanType.STARTER, "slack-integration")).toBe(true);
    expect(hasEntitlement(PlanType.PRO, "slack-integration")).toBe(true);
    expect(hasEntitlement(PlanType.ENTERPRISE, "slack-integration")).toBe(true);
  });
});

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

describe("isIngestionBlocked", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_BILLING", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Free: blocked at exactly the 50k span cap (hard cap)", () => {
    const cap = USAGE_CONFIG.includedUnits;
    expect(isIngestionBlocked(PlanType.FREE, 0)).toBe(false);
    expect(isIngestionBlocked(PlanType.FREE, cap - 1)).toBe(false);
    expect(isIngestionBlocked(PlanType.FREE, cap)).toBe(true);
    expect(isIngestionBlocked(PlanType.FREE, cap + 100_000)).toBe(true);
  });

  // Regression: the free→paid upgrade case. A workspace that tripped the Free
  // cap (ingestion_blocked=true) and upgraded must NOT remain blocked — paid
  // ingestion overage is billed via Stripe, never hard-blocked. Mirrors the
  // paid-plan unblock branch already present for AI/RCA/detector.
  it("Paid plans: never blocked, even far above the free cap", () => {
    const wayOverFreeCap = USAGE_CONFIG.includedUnits * 100;
    expect(isIngestionBlocked(PlanType.STARTER, wayOverFreeCap)).toBe(false);
    expect(isIngestionBlocked(PlanType.PRO, wayOverFreeCap)).toBe(false);
    expect(isIngestionBlocked(PlanType.ENTERPRISE, wayOverFreeCap)).toBe(false);
  });

  it("respects ENABLE_BILLING=false (unblocks all)", () => {
    vi.stubEnv("ENABLE_BILLING", "false");
    expect(isIngestionBlocked(PlanType.FREE, 9_999_999)).toBe(false);
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
