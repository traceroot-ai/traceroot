/**
 * Stripe configuration that switches between test and production based on STRIPE_MODE
 */

interface StripeConfig {
  publishableKey: string;
  planPriceIds: {
    starter: string;
    pro: string;
    startups: string;
  };
  mode: 'test' | 'production';
}

function getStripeConfig(): StripeConfig {
  // Get the Stripe mode from environment, default to 'test'
  const stripeMode = (process.env.NEXT_PUBLIC_STRIPE_MODE || 'test').toLowerCase();

  if (stripeMode !== 'test' && stripeMode !== 'production') {
    console.warn(`Invalid STRIPE_MODE '${stripeMode}'. Defaulting to 'test'.`);
    return getTestConfig();
  }

  if (stripeMode === 'production') {
    return getProductionConfig();
  } else {
    return getTestConfig();
  }
}

function getTestConfig(): StripeConfig {
  const config = {
    publishableKey: process.env.NEXT_PUBLIC_TEST_STRIPE_PUBLISHABLE_KEY!,
    planPriceIds: {
      starter: process.env.NEXT_PUBLIC_TEST_STRIPE_PLAN_STARTER_PRICE_ID!,
      pro: process.env.NEXT_PUBLIC_TEST_STRIPE_PLAN_PRO_PRICE_ID!,
      startups: process.env.NEXT_PUBLIC_TEST_STRIPE_PLAN_STARTUP_PRICE_ID!,
    },
    mode: 'test' as const,
  };

  // Validate test configuration
  const missing = [];
  if (!config.publishableKey) missing.push('NEXT_PUBLIC_TEST_STRIPE_PUBLISHABLE_KEY');
  if (!config.planPriceIds.starter) missing.push('NEXT_PUBLIC_TEST_STRIPE_PLAN_STARTER_PRICE_ID');
  if (!config.planPriceIds.pro) missing.push('NEXT_PUBLIC_TEST_STRIPE_PLAN_PRO_PRICE_ID');
  if (!config.planPriceIds.startups) missing.push('NEXT_PUBLIC_TEST_STRIPE_PLAN_STARTUP_PRICE_ID');

  if (missing.length > 0) {
    console.error('Missing test Stripe environment variables:', missing);
  }

  return config;
}

function getProductionConfig(): StripeConfig {
  const config = {
    publishableKey: process.env.NEXT_PUBLIC_PRODUCTION_STRIPE_PUBLISHABLE_KEY!,
    planPriceIds: {
      starter: process.env.NEXT_PUBLIC_PRODUCTION_STRIPE_PLAN_STARTER_PRICE_ID!,
      pro: process.env.NEXT_PUBLIC_PRODUCTION_STRIPE_PLAN_PRO_PRICE_ID!,
      startups: process.env.NEXT_PUBLIC_PRODUCTION_STRIPE_PLAN_STARTUP_PRICE_ID!,
    },
    mode: 'production' as const,
  };

  // Validate production configuration
  const missing = [];
  if (!config.publishableKey) missing.push('NEXT_PUBLIC_PRODUCTION_STRIPE_PUBLISHABLE_KEY');
  if (!config.planPriceIds.starter) missing.push('NEXT_PUBLIC_PRODUCTION_STRIPE_PLAN_STARTER_PRICE_ID');
  if (!config.planPriceIds.pro) missing.push('NEXT_PUBLIC_PRODUCTION_STRIPE_PLAN_PRO_PRICE_ID');
  if (!config.planPriceIds.startups) missing.push('NEXT_PUBLIC_PRODUCTION_STRIPE_PLAN_STARTUP_PRICE_ID');

  if (missing.length > 0) {
    console.error('Missing production Stripe environment variables:', missing);
  }

  return config;
}

// Export the configuration
export const stripeConfig = getStripeConfig();

// Log the current configuration (without exposing secrets)
console.log('Stripe Configuration:', {
  mode: stripeConfig.mode,
  publishableKey: stripeConfig.publishableKey ? `${stripeConfig.publishableKey.substring(0, 12)}...` : 'NOT SET',
  planPriceIds: stripeConfig.planPriceIds,
});
