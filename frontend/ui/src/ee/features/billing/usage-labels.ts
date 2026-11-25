// Pure helpers for rendering RCA / detector usage labels on the billing page.
// Extracted from BillingTab so the logic is unit-testable without rendering React.

import { RCA_RUN_QUOTAS } from "@traceroot/core";
import type { Translate } from "@/lib/i18n/translate";

export interface QuotaConfig {
  included: number;
  overageLabel: string;
}

export { RCA_RUN_QUOTAS };

/** `t` puts the label in the visitor's language; without it the label is English. */
export function formatRcaQuotaLabel(quota: QuotaConfig, runsUsed: number, t?: Translate): string {
  if (quota.included === Infinity) {
    return t ? t("billing.unlimitedCount", { count: runsUsed }) : `${runsUsed} (Unlimited)`;
  }
  return `${runsUsed} / ${quota.included}`;
}

export function formatDetectorScanLabel(scansRun: number): string {
  return scansRun.toLocaleString();
}
