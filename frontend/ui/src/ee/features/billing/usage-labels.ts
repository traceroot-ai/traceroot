// Pure helpers for rendering RCA / detector usage labels on the billing page.
// Extracted from BillingTab so the logic is unit-testable without rendering React.

import { RCA_RUN_QUOTAS } from "@traceroot/core";

export interface QuotaConfig {
  included: number;
  overageLabel: string;
}

export { RCA_RUN_QUOTAS };

export function formatRcaQuotaLabel(quota: QuotaConfig, runsUsed: number): string {
  if (quota.included === Infinity) {
    return `${runsUsed} (Unlimited)`;
  }
  return `${runsUsed} / ${quota.included}`;
}

export function formatDetectorScanLabel(scansRun: number): string {
  return scansRun.toLocaleString();
}
