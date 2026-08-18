import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, bearer, deviceAuthorization } from "better-auth/plugins";
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

  plugins: [
    admin({
      impersonationSessionDuration: 60 * 60 * 24, // 1 day
    }),
    // Lets a session token double as an `Authorization: Bearer <token>` header,
    // which the CLI uses after completing the device flow. requireSignature must
    // stay false (the default): device-flow tokens are unsigned, and turning on
    // signature verification would reject every one of them.
    bearer(),
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
