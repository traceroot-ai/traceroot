import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization, jwt } from "better-auth/plugins";
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { DEVICE_CLIENT_IDS } from "@/lib/auth-clients";
import { generateUserCode } from "@/lib/device-user-code";
import { trustedProxyCidrs } from "@/lib/trusted-proxies";
import { authRateLimitStorage } from "@/lib/auth-rate-limit";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";
import { supportPlugin } from "@/lib/support/auth-plugin";
import { captureServerEvent } from "@/lib/posthog-server";
import { onEmailVerified, onUserCreated } from "@/lib/signup/on-user-created";
import { isSelfSignup, signupAttributionProperties } from "@/lib/signup/attribution";
import { checkSignupEmail, EMAIL_POLICY_MESSAGES } from "@/lib/signup/email-policy";
import {
  isVerificationMailConfigured,
  sendVerificationEmail,
} from "@/lib/signup/verification-email";
import { ensureDemoMembership } from "@/lib/demo-workspace";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "@/lib/session-config";

const ac = createAccessControl(defaultStatements);

// Email/password accounts must prove the address before they can sign in, but
// only where a verification link can be delivered: without mail configured
// (typical for self-hosting) the requirement would lock every new account out.
const requireEmailVerification = isVerificationMailConfigured();
if (!requireEmailVerification) {
  console.warn(
    "[auth] email verification is off: set RESEND_API_KEY and TRACEROOT_UPDATES_EMAIL_FROM (or TRACEROOT_SMTP_MAIL_FROM) to require it",
  );
}

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Accounts that existed before this was enabled were marked verified by
    // the grandfather_email_verified migration, so they are not locked out.
    requireEmailVerification,
  },

  emailVerification: {
    sendVerificationEmail: ({ user, url }) => sendVerificationEmail({ user, url }),
    // An unverified sign-in attempt gets a fresh link, which doubles as resend.
    sendOnSignIn: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    // The welcome and Slack notice held back at creation go out now. Not
    // awaited: better-auth awaits this inside the verify request.
    afterEmailVerification: async (user) => {
      onEmailVerified({
        id: user.id,
        email: user.email,
        name: user.name ?? null,
        createdAt: user.createdAt,
      }).catch((error) => console.error("[signup] verified follow-up failed:", error));
    },
  },

  databaseHooks: {
    user: {
      create: {
        // Runs for every self-service account (email and OAuth) before the row
        // is written, so a rejected address never reaches the after-hook's mail
        // and Slack side effects. Staff provisioning is exempt.
        before: async (user, context) => {
          if (!isSelfSignup(context)) return;
          const verdict = checkSignupEmail(user.email);
          if (!verdict.ok) {
            throw new APIError("BAD_REQUEST", {
              code: `EMAIL_DOMAIN_${verdict.reason.toUpperCase()}`,
              message: EMAIL_POLICY_MESSAGES[verdict.reason],
            });
          }
        },
        // better-auth awaits after-hooks and a throw propagates into the sign-up
        // response, so this calls without awaiting and the callee never rejects.
        after: async (user, context) => {
          captureServerEvent(user.id, "user_signed_up", signupAttributionProperties(context));
          onUserCreated(
            { id: user.id, email: user.email, name: user.name ?? null },
            context ? { path: context.path } : null,
            { awaitingVerification: requireEmailVerification && !user.emailVerified },
          ).catch((error) => console.error("[signup] follow-up failed:", error));
        },
      },
    },
    session: {
      create: {
        // Each login re-checks the demo workspace membership, so users that
        // the backfill missed (or that were removed) join at their next login.
        // Not awaited, and ensureDemoMembership never rejects, so it cannot
        // slow down or break sign-in.
        after: async (session) => {
          void ensureDemoMembership(session.userId);
        },
      },
    },
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
    // Enabled automatically in production. Keyed on the resolved client
    // address, so a cap is only per-caller when that address resolves; see
    // advanced.ipAddress above.
    //
    // With REDIS_URL set, counters are shared by every replica and survive a
    // restart (see lib/auth-rate-limit.ts). Without it they fall back to
    // per-instance memory: N replicas means N budgets per client. Either way
    // the unforgeable per-address bound lives at the edge WAF.
    customStorage: authRateLimitStorage(env.REDIS_URL),
    customRules: {
      // `/device/code` is unauthenticated and inserts a device_codes row on
      // every call, so a loop would grow the table unbounded — cap creation.
      "/device/code": { window: 60, max: 10 },
      // A person signs up once, maybe retrying a typo; the library default
      // (3 per 10 s, ~26k a day) only stops bursts. 10 an hour still lets a
      // team behind one NAT accept their invites together.
      "/sign-up/email": { window: 60 * 60, max: 10 },
    },
  },

  plugins: [
    admin({
      ac,
      roles: {
        admin: adminAc,
        support: ac.newRole({ user: ["list", "get", "impersonate"], session: [] }),
      },
      adminRoles: ["admin", "support"],
      impersonationSessionDuration: SESSION_EXPIRES_IN_SECONDS,
    }),
    supportPlugin(),
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
      // Browser get-session must never mint an exportable customer JWT.
      disableSettingJwtHeader: true,
      jwt: { expirationTime: "10m" },
      jwks: { keyPairConfig: { alg: "EdDSA" } },
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
