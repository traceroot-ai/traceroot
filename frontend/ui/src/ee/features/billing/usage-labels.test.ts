import { describe, it, expect } from "vitest";
import { PlanType } from "@traceroot/core";
import { RCA_RUN_QUOTAS, formatRcaQuotaLabel, formatDetectorScanLabel } from "./usage-labels";

describe("RCA_RUN_QUOTAS", () => {
  it("matches the Phase 2 spec — 30 / 100 / 100 / unlimited", () => {
    expect(RCA_RUN_QUOTAS[PlanType.FREE].included).toBe(30);
    expect(RCA_RUN_QUOTAS[PlanType.STARTER].included).toBe(100);
    expect(RCA_RUN_QUOTAS[PlanType.PRO].included).toBe(100);
    expect(RCA_RUN_QUOTAS[PlanType.ENTERPRISE].included).toBe(Infinity);
  });

  it("Starter and Pro share the same RCA pool (quota-parity rule)", () => {
    expect(RCA_RUN_QUOTAS[PlanType.STARTER].included).toBe(RCA_RUN_QUOTAS[PlanType.PRO].included);
    expect(RCA_RUN_QUOTAS[PlanType.STARTER].overageLabel).toBe(
      RCA_RUN_QUOTAS[PlanType.PRO].overageLabel,
    );
  });
});

describe("formatRcaQuotaLabel", () => {
  it("renders quota for finite plans", () => {
    expect(formatRcaQuotaLabel({ included: 100, overageLabel: "x" }, 7)).toBe("7 / 100");
    expect(formatRcaQuotaLabel({ included: 30, overageLabel: "x" }, 0)).toBe("0 / 30");
  });

  it("renders Unlimited for enterprise plans", () => {
    expect(formatRcaQuotaLabel({ included: Infinity, overageLabel: "x" }, 42)).toBe(
      "42 (Unlimited)",
    );
  });
});

describe("formatDetectorScanLabel", () => {
  it("formats with locale-string commas", () => {
    expect(formatDetectorScanLabel(0)).toBe("0");
    expect(formatDetectorScanLabel(1234)).toBe("1,234");
    expect(formatDetectorScanLabel(1_234_567)).toBe("1,234,567");
  });
});
