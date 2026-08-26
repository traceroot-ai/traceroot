import { z } from "zod";

// Values this repository shipped as defaults in .env.example or
// docker-compose.prod.yml. They are public, so they are not secrets: a
// deployment still carrying one signs sessions with a key anyone can read.
const PUBLISHED_PLACEHOLDERS = new Set([
  "dev-internal-secret",
  "internal-secret",
  "your-better-auth-secret",
  "local-dev-secret-change-in-production",
  "changeme",
]);

export const authSecret = () =>
  z
    .string()
    .min(1)
    .refine((value) => !PUBLISHED_PLACEHOLDERS.has(value.trim().toLowerCase()), {
      message:
        "value is a placeholder published in this repository; generate one with `openssl rand -hex 32`",
    });

const serverSchema = z.object({
  BETTER_AUTH_SECRET: authSecret(),
  BETTER_AUTH_URL: z.string().default("http://localhost:3000"),
  INTERNAL_API_SECRET: authSecret(),
  AUTH_GOOGLE_CLIENT_ID: z.string().default(""),
  AUTH_GOOGLE_CLIENT_SECRET: z.string().default(""),
  TRACEROOT_SMTP_URL: z.string().optional(),
  TRACEROOT_SMTP_MAIL_FROM: z.string().optional(),
  NEXT_PUBLIC_APP_URL: z.string().default("http://localhost:3000"),
  NEXT_PUBLIC_LOGO_URL: z.string().optional(),
  // Billing toggle — set to "false" for self-hosted deployments to unlock all features
  ENABLE_BILLING: z.string().default("true"),
  TRACEROOT_EE_LICENSE_KEY: z.string().optional(),
  // Stripe Billing
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SIGNING_SECRET: z.string().default(""),
  STRIPE_PRICE_ID_STARTER: z.string().default(""),
  STRIPE_PRICE_ID_PRO: z.string().default(""),
  // Encryption (BYOK)
  ENCRYPTION_KEY: z.string().length(64).optional(), // 64 hex chars = 256 bits
  // GitHub App
  GITHUB_APP_ID: z.string().default(""),
  GITHUB_APP_NAME: z.string().default(""),
  GITHUB_APP_PRIVATE_KEY: z.string().default(""),
  GITHUB_APP_CLIENT_ID: z.string().default(""),
  GITHUB_APP_CLIENT_SECRET: z.string().default(""),
  GITHUB_OAUTH_REDIRECT_URI: z.string().default("http://localhost:3000/api/github/callback"),
  // Slack App
  SLACK_CLIENT_ID: z.string().default(""),
  SLACK_CLIENT_SECRET: z.string().default(""),
  SLACK_STATE_SECRET: z.string().default(""),
  SLACK_REDIRECT_URI: z.string().default("http://localhost:3000/api/slack/oauth/callback"),
});

export const env = serverSchema.parse(process.env);
