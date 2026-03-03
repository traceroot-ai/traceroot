"""
Enterprise Edition license gate functions.

Two independent gates:
- is_ee_enabled(): checks TRACEROOT_EE_LICENSE_KEY for enterprise features (SSO, audit logs, RBAC)
- is_billing_enabled(): checks ENABLE_BILLING for cloud billing (Stripe checkout, metering)
"""

import os


def is_ee_enabled() -> bool:
    """Check if enterprise features are enabled via license key."""
    return bool(os.environ.get("TRACEROOT_EE_LICENSE_KEY"))


def is_billing_enabled() -> bool:
    """Check if cloud billing is enabled (Stripe, usage metering)."""
    return os.environ.get("ENABLE_BILLING", "").lower() != "false"
