export type SubscriptionPlan = 'starter' | 'pro' | 'startups';

export interface UserSubscription {
  user_email: string;
  hasAccess: boolean;
  subscription_plan: SubscriptionPlan;
  start_date: string;
  payment_history: PaymentRecord[];
}

export interface PaymentRecord {
  amount: number;
  date: string;
  stripe_payment_id: string;
}

// TODO (xinwei): use dynamic pricing from Stripe
export const PLAN_PRICES = {
  starter: 19,
  pro: 49,
  startups: 449
} as const;

export const PLAN_FEATURES = {
  starter: [
    '150k trace + logs, basic AI insights, 30d retention',
    'Source code is visible in the UI but our AI agent does not have access to it',
    'AI agent only has chat mode'
  ],
  pro: [
    'Everything in Starter',
    'Unlimited users',
    'AI agent has chat + agent mode',
    'Optional full codebase access (GitHub integration)',
    'AI Agent auto-triaging production issues'
  ],
  startups: [
    'Everything in Pro',
    '2M trace + logs',
    'Slack & Notion integration',
    'Full GitHub support with ticket/PR context',
    'SOC2 & ISO27001 reports, BAA available (HIPAA)'
  ]
} as const;
