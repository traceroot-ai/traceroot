import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization, jwt } from "better-auth/plugins";
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

  rateLimit: {
    // Enabled automatically in production. `/device/code` is unauthenticated and
    // inserts a device_codes row on every call, so a loop would grow the table
    // unbounded — cap creation. better-auth keys the limit on the client IP,
    // read from x-forwarded-for by default; behind a proxy that *appends* to
    // XFF the address can't be resolved and every caller falls into one shared
    // bucket, so for reliable per-client keying set
    // `advanced.ipAddress.trustedProxies` to the edge's CIDRs (a deploy config).
    // Storage is per-instance memory by default: a coarse bound, not a
    // cross-replica guarantee.
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
    // Signs the short-lived CLI access tokens. The CLI stores the long-lived
    // session token as a refresh credential and exchanges it (via
    // /api/cli/token) for a 10-minute EdDSA JWT that is the actual request
    // bearer; the Python backend verifies that JWT offline against /api/auth/jwks
    // (no per-request introspection for the identity check). Keys live in the
    // `jwks` table. bearer() stays off — the exchange route validates the
    // session by a direct lookup, so the session token never rides /api/auth.
    jwt({
      jwt: { expirationTime: "10m" },
      jwks: { keyPairConfig: { alg: "EdDSA" } },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
