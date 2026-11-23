import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization, genericOAuth, jwt } from "better-auth/plugins";
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { DEVICE_CLIENT_IDS } from "@/lib/auth-clients";
import { generateUserCode } from "@/lib/device-user-code";
import { getSocialAuthConfig } from "@/lib/social-auth";
import { trustedProxyCidrs } from "@/lib/trusted-proxies";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, adminAc } from "better-auth/plugins/admin/access";
import { supportPlugin } from "@/lib/support/auth-plugin";
import { captureServerEvent } from "@/lib/posthog-server";
import { onUserCreated } from "@/lib/signup/on-user-created";
import { signupAttributionProperties } from "@/lib/signup/attribution";
import { signupEmailPolicyHook } from "@/lib/signup/email-policy-hook";
import { isCloud } from "@/lib/server/cloud";
import { ensureDemoMembership } from "@/lib/demo-workspace";
import { agentIdProvider } from "@/lib/agentid";
import { AGENTID_PROVIDER_ID, configuredSocialProviders } from "@/lib/social-providers";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_FRESH_AGE_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
} from "@/lib/session-config";

const ac = createAccessControl(defaultStatements);
const { socialProviders } = getSocialAuthConfig();

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  // Failed OAuth callbacks land on the app's error page, not better-auth's.
  onAPIError: { errorURL: new URL("/auth/error", env.BETTER_AUTH_URL).toString() },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },

  databaseHooks: {
    user: {
      create: {
        before: signupEmailPolicyHook(isCloud()),
        // better-auth awaits after-hooks and a throw propagates into the sign-up
        // response, so this calls without awaiting and the callee never rejects.
        after: async (user, context) => {
          captureServerEvent(user.id, "user_signed_up", signupAttributionProperties(context));
          onUserCreated(
            { id: user.id, email: user.email, name: user.name ?? null },
            context ? { path: context.path, provider: context.params?.id } : null,
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

  socialProviders,

  account: {
    accountLinking: {
      enabled: true,
      // A trusted provider is one whose *unverified* email addresses may still
      // be used as proof of ownership when linking into an account that already
      // exists: better-auth skips the `emailVerified` check on the incoming
      // profile for these. GitHub is deliberately absent. It serves the
      // account's primary address whether or not that address has been
      // confirmed, so trusting it would let anyone who adds a victim's address
      // to their own GitHub account sign in as that victim. Leaving it out
      // costs nothing a real user notices: a GitHub identity whose address *is*
      // verified still links, and a first-time GitHub sign-in still creates an
      // account either way. account-linking.test.ts pins both halves.
      // Never add "agentid" either: a trusted provider links on email alone.
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
    ...(configuredSocialProviders(env).includes(AGENTID_PROVIDER_ID)
      ? [genericOAuth({ config: [agentIdProvider(env)] })]
      : []),
  ],
});

export type Session = typeof auth.$Infer.Session;
