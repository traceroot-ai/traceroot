import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization, jwt } from "better-auth/plugins";
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { DEVICE_CLIENT_IDS } from "@/lib/auth-clients";
import { generateUserCode } from "@/lib/device-user-code";
import { trustedProxyCidrs } from "@/lib/trusted-proxies";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "@/lib/session-config";

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
    // Rolling idle-timeout window (see session-config.ts). updateAge is set
    // explicitly rather than left to better-auth's default so the CLI mint
    // route can track the exact same slide cadence. Applies to every session,
    // browser included — a session unused for expiresIn must re-authenticate.
    expiresIn: SESSION_EXPIRES_IN_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
    // Off — otherwise /list-sessions 403s for any session older than freshAge
    // (default 24h) and the Active Sessions revocation UI can't load. See
    // session-config.ts.
    freshAge: SESSION_FRESH_AGE_SECONDS,
  },

  advanced: {
    ipAddress: {
      // Resolves the caller from x-forwarded-for. Empty means only a
      // single-entry header is trusted; ranges switch it to walking the chain
      // from the right. See lib/trusted-proxies.ts for why that matters and
      // what configuring it costs.
      trustedProxies: trustedProxyCidrs(env.AUTH_TRUSTED_PROXY_CIDRS),
    },
  },

  rateLimit: {
    // Enabled automatically in production. `/device/code` is unauthenticated and
    // inserts a device_codes row on every call, so a loop would grow the table
    // unbounded — cap creation. The cap is keyed on the resolved client
    // address, so it is only per-caller when that address resolves; see
    // advanced.ipAddress above.
    //
    // Storage is per-instance memory: N replicas means N budgets per client and
    // a restart clears them. A coarse bound, not a cross-replica guarantee, so
    // the unforgeable per-address bound lives at the edge WAF.
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
