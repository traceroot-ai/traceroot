import { loadStripe } from '@stripe/stripe-js';
import { SubscriptionPlan } from '@/types/subscription';
import { stripeConfig } from '@/config/stripe';

// Debug logging for environment variables
console.log('Environment Variables:', {
  mode: stripeConfig.mode,
  publishableKey: stripeConfig.publishableKey ? `${stripeConfig.publishableKey.substring(0, 12)}...` : 'NOT SET',
  priceIds: stripeConfig.planPriceIds,
});

// Initialize Stripe with the configured publishable key
const stripePromise = loadStripe(stripeConfig.publishableKey);


// Debug logging for price IDs
// console.log('Price IDs Configuration:', PLAN_PRICE_IDS);

export async function redirectToCheckout(plan: SubscriptionPlan, userEmail: string) {
  try {
    console.log(`Starting checkout for plan: ${plan}`);

    // Don't allow checkout for invalid plans
    if (!plan) {
      throw new Error('Invalid plan selected');
    }

    const stripe = await stripePromise;
    if (!stripe) throw new Error('Stripe failed to initialize');

    const priceId = stripeConfig.planPriceIds[plan];
    if (!priceId) throw new Error('Price ID not found for selected plan');

    // Create Stripe Checkout Session using our Next.js API route
    const response = await fetch('/api/create-checkout-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        priceId,
        plan,
        userEmail
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create checkout session: ${errorText}`);
    }

    const { sessionId } = await response.json();

    // Redirect to Stripe Checkout
    const result = await stripe.redirectToCheckout({
      sessionId
    });

    if (result.error) {
      throw new Error(result.error.message);
    }

  } catch (err) {
    console.error('Error in redirectToCheckout:', err);
    throw err;
  }
}

export async function createPortalSession(userEmail: string): Promise<string> {
  try {
    console.log(`Creating portal session for: ${userEmail}`);

    const response = await fetch('/api/create-portal-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userEmail }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create portal session: ${error}`);
    }

    const { url } = await response.json();
    console.log('Portal session URL:', url);

    return url;
  } catch (err) {
    console.error('Error creating portal session:', err);
    throw err;
  }
}
