/**
 * Enterprise Edition license gate functions.
 *
 * Two independent gates:
 * - isEeEnabled(): checks TRACEROOT_EE_LICENSE_KEY for enterprise features (SSO, audit logs, RBAC)
 * - isBillingEnabled(): checks ENABLE_BILLING for cloud billing (Stripe checkout, metering)
 */

// Gate 1: Enterprise features (SSO, audit logs, advanced RBAC)
export const isEeEnabled = (): boolean => {
  return !!process.env.TRACEROOT_EE_LICENSE_KEY;
};

// Gate 2: Cloud billing (Stripe checkout, metering, webhooks)
// Disabled only when ENABLE_BILLING is exactly "false" (trimmed + lowercased so
// a quoted "  false  " from env/YAML still counts; matches backend ee/license.py).
export const isBillingEnabled = (): boolean => {
  return (process.env.ENABLE_BILLING ?? "").trim().toLowerCase() !== "false";
};
