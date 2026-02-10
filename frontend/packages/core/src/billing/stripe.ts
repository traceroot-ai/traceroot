import Stripe from "stripe";

export const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : undefined;

export function getStripeOrThrow(): Stripe {
  if (!stripe) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
  }
  return stripe;
}
