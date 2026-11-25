import type { MessageKey } from "@/lib/i18n/messages/en";
import type { Translate } from "@/lib/i18n/translate";

// PLANS in @traceroot/core describes each plan in English, and the billing services read the
// same object. This maps those texts to their translatable copies for the pricing dialog. A text
// that is not listed here (a plan edited without updating this map) is shown as written.
const PLAN_TEXT_KEYS: Record<string, MessageKey> = {
  popular: "billingPlans.popular",
  "Get started with core features.": "billingPlans.freeText",
  "For small teams.": "billingPlans.starterText",
  "For growing teams.": "billingPlans.proText",
  "For scaling organizations.": "billingPlans.enterpriseText",
  "2 seats": "billingPlans.seats2",
  "50k events / month included": "billingPlans.events50k",
  "15-day retention": "billingPlans.retention15",
  "100 detector runs / month": "billingPlans.detectorRuns100",
  "30 chat + 30 RCA runs / month": "billingPlans.chatRca30",
  "Slack alerts · BYOK or hosted LLM": "billingPlans.slackByok",
  "Everything in Free": "billingPlans.allOfFree",
  "Unlimited seats": "billingPlans.seatsUnlimited",
  "150k events / month, $4 per 50k over": "billingPlans.events150k",
  "30-day retention": "billingPlans.retention30",
  "100 chat + 100 RCA runs / month, $10 per 100 over each": "billingPlans.chatRca100",
  "Unlimited detector runs": "billingPlans.detectorRunsUnlimited",
  "Hosted LLM token cost × 1.05 on overage": "billingPlans.hostedOverage",
  "Everything in Starter": "billingPlans.allOfStarter",
  "90-day retention": "billingPlans.retention90",
  "Higher rate limits": "billingPlans.rateLimits",
  "SOC 2 report & HIPAA BAA": "billingPlans.compliance",
  "Everything in Pro": "billingPlans.allOfPro",
  "Custom retention": "billingPlans.retentionCustom",
  "SLA support": "billingPlans.sla",
};

export function displayPlanText(t: Translate, text: string): string {
  return Object.hasOwn(PLAN_TEXT_KEYS, text) ? t(PLAN_TEXT_KEYS[text]) : text;
}
