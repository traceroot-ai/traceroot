import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization } from "better-auth/plugins";
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { DEVICE_CLIENT_IDS } from "@/lib/auth-clients";
import { generateUserCode } from "@/lib/device-user-code";

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },

  socialProviders: {
    google: {
      clientId: env.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET,
    },
  },

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },

  session: {
    expiresIn: 30 * 24 * 60 * 60, // 30 days
  },

  advanced: {
    ipAddress: {
      // Behind the platform proxy the real client IP arrives in
      // x-forwarded-for; without this the rate limiter can't key per-client and
      // degrades to one shared per-path bucket.
      ipAddressHeaders: ["x-forwarded-for"],
    },
  },

  rateLimit: {
    // Enabled automatically in production. `/device/code` is unauthenticated and
    // inserts a device_codes row on every call, so a loop would grow the table
    // unbounded — cap creation per client IP. (Per-instance memory storage by
    // default: a coarse bound, not a cross-replica guarantee.)
    customRules: {
      "/device/code": { window: 60, max: 10 },
    },
  },

  plugins: [
    admin({
      impersonationSessionDuration: 60 * 60 * 24, // 1 day
    }),
    // The CLI credential is a session token, but bearer() is deliberately NOT
    // enabled: it would let that token authenticate every /api/auth/* endpoint
    // and would expose session tokens to page JS on sign-in. The backend
    // introspects the token by a direct session lookup instead (see
    // internal-session.ts), so it never needs to ride the better-auth header.
    deviceAuthorization({
      expiresIn: "30m", // a sign-up round trip (not just sign-in) needs to fit in the window
      interval: "5s",
      generateUserCode,
      validateClient: (clientId) => DEVICE_CLIENT_IDS.has(clientId),
      verificationUri: "/device",
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
