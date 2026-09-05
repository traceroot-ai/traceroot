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
  isUpgrade,
  getPlanOrder,
  toPlanType,
  ENTITLEMENTS,
} from "../plans.ts";

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

describe("toPlanType", () => {
  beforeEach(() => {
    vi.stubEnv("ENABLE_BILLING", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns every recognized plan unchanged", () => {
    for (const plan of Object.values(PlanType)) {
      expect(toPlanType(plan)).toBe(plan);
    }
  });

  it("fails closed to FREE for anything unrecognized", () => {
    // billingPlan is free-form TEXT with no CHECK constraint, so these are all
    // values a workspace row can actually hold.
    expect(toPlanType("legacy-team")).toBe(PlanType.FREE);
    expect(toPlanType("Pro")).toBe(PlanType.FREE); // matching is exact
    expect(toPlanType("pro ")).toBe(PlanType.FREE); // trailing whitespace
    expect(toPlanType("")).toBe(PlanType.FREE);
    expect(toPlanType(null)).toBe(PlanType.FREE);
    expect(toPlanType(undefined)).toBe(PlanType.FREE);
  });

  it("does not resolve prototype-chain keys to a plan", () => {
    expect(toPlanType("constructor")).toBe(PlanType.FREE);
    expect(toPlanType("toString")).toBe(PlanType.FREE);
    expect(toPlanType("__proto__")).toBe(PlanType.FREE);
  });

  it("gives an unrecognized plan the same entitlements as an explicit FREE", () => {
    // The failure mode this closes: an unrecognized plan is absent from the
    // entitlement table, so every entitlement check answered false for it —
    // byok included, which is granted on every plan including Free.
    expect(hasEntitlement("legacy-team" as PlanType, "byok")).toBe(false);

    expect(hasEntitlement(toPlanType("legacy-team"), "byok")).toBe(
      hasEntitlement(PlanType.FREE, "byok"),
    );
    for (const entitlement of ENTITLEMENTS) {
      expect(hasEntitlement(toPlanType("legacy-team"), entitlement)).toBe(
        hasEntitlement(PlanType.FREE, entitlement),
      );
    }
  });

  it("restores plan ordering, which an unrecognized plan left undefined", () => {
    expect(getPlanOrder("legacy-team" as PlanType)).toBeUndefined();
    expect(isUpgrade("legacy-team" as PlanType, PlanType.PRO)).toBe(false);

    expect(getPlanOrder(toPlanType("legacy-team"))).toBe(getPlanOrder(PlanType.FREE));
    expect(isUpgrade(toPlanType("legacy-team"), PlanType.PRO)).toBe(true);
  });

  it("leaves a recognized plan's ordering and entitlements untouched", () => {
    expect(isUpgrade(toPlanType("pro"), PlanType.ENTERPRISE)).toBe(true);
    expect(isUpgrade(toPlanType("pro"), PlanType.STARTER)).toBe(false);
    expect(hasEntitlement(toPlanType("pro"), "github-integration")).toBe(true);
    expect(hasEntitlement(toPlanType("starter"), "github-integration")).toBe(false);
  });
});
