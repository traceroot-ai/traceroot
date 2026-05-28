import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin } from "better-auth/plugins";
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { getGoogleAuthProviderConfig, isGoogleAuthConfigured } from "@/lib/google-auth-config";

const googleSocialProviders = getGoogleAuthProviderConfig();
const trustedProviders = isGoogleAuthConfigured() ? ["google"] : [];

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

  ...(googleSocialProviders ? { socialProviders: googleSocialProviders } : {}),

  account: {
    accountLinking: {
      enabled: true,
      trustedProviders,
    },
  },

  session: {
    expiresIn: 30 * 24 * 60 * 60, // 30 days
  },

  plugins: [
    admin({
      impersonationSessionDuration: 60 * 60 * 24, // 1 day
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
