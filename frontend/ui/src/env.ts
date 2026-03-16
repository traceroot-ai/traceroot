import { z } from "zod";

const serverSchema = z.object({
  NEXTAUTH_SECRET: z.string().min(1),
  NEXTAUTH_URL: z.string().default("http://localhost:3000"),
  INTERNAL_API_SECRET: z.string().min(1),
  AUTH_GOOGLE_CLIENT_ID: z.string().default(""),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().default(""),
  TRACEROOT_SMTP_URL: z.string().optional(),
  TRACEROOT_SMTP_MAIL_FROM: z.string().optional(),
  NEXT_PUBLIC_LOGO_URL: z.string().optional(),
  // Billing toggle — set to "false" for self-hosted deployments to unlock all features
  ENABLE_BILLING: z.string().default("true"),
  TRACEROOT_EE_LICENSE_KEY: z.string().optional(),
  // Stripe Billing
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SIGNING_SECRET: z.string().default(""),
  STRIPE_PRICE_ID_STARTER: z.string().default(""),
  STRIPE_PRICE_ID_PRO: z.string().default(""),
  STRIPE_PRICE_ID_STARTUPS: z.string().default(""), // maps to Enterprise plan (will be renamed in backend migration)
  // Encryption (BYOK)
  ENCRYPTION_KEY: z.string().length(64).optional(), // 64 hex chars = 256 bits
  // GitHub App
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_NAME: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  GITHUB_APP_CLIENT_ID: z.string().default(""),
  GITHUB_APP_CLIENT_SECRET: z.string().default(""),
  GITHUB_OAUTH_REDIRECT_URI: z.string().default("http://localhost:3000/api/github/callback"),
});

export const env = serverSchema.parse(process.env);
