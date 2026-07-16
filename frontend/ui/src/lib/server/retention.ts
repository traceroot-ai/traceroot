import { NextResponse } from "next/server";
import { PlanType } from "@traceroot/core";

const PLAN_RETENTION_DAYS: Record<string, number | null> = {
  [PlanType.FREE]: 15,
  [PlanType.STARTER]: 30,
  [PlanType.PRO]: 90,
  [PlanType.ENTERPRISE]: null,
};
const FAIL_CLOSED_DAYS = 15;

export function checkRetention(billingPlan: string, startAfter: string): NextResponse | null {
  const days = Object.prototype.hasOwnProperty.call(PLAN_RETENTION_DAYS, billingPlan)
    ? PLAN_RETENTION_DAYS[billingPlan]
    : FAIL_CLOSED_DAYS;
  if (days === null) return null;
  const cutoff = new Date(Date.now() - days * 86_400_000 - 3_600_000);
  const parsed = new Date(startAfter);
  if (isNaN(parsed.getTime()) || parsed < cutoff) {
    return NextResponse.json(
      {
        detail: {
          message: "Data outside retention window",
          retention_days: days,
          cutoff: cutoff.toISOString(),
          plan: billingPlan,
        },
      },
      { status: 403 },
    );
  }
  return null;
}

export function getRetentionCutoff(billingPlan: string): string | null {
  const days = Object.prototype.hasOwnProperty.call(PLAN_RETENTION_DAYS, billingPlan)
    ? PLAN_RETENTION_DAYS[billingPlan]
    : FAIL_CLOSED_DAYS;
  if (days === null) return null;
  return new Date(Date.now() - days * 86_400_000 - 3_600_000).toISOString();
}
