import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, deviceAuthorization } from "better-auth/plugins";
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { DEVICE_CLIENT_IDS } from "@/lib/auth-clients";

// Unambiguous alphabet (no 0/O/1/I) so a user reading the code aloud, or typing
// it from a screen at a glance, can't confuse similar-looking characters.
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 8-character code split into two hyphenated groups (XXXX-XXXX) — easier to
// read and re-type than a single unbroken run of 8 characters.
function hyphenated8(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
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
    deviceAuthorization({
      expiresIn: "30m", // a sign-up round trip (not just sign-in) needs to fit in the window
      interval: "5s",
      generateUserCode: hyphenated8,
      validateClient: (clientId) => DEVICE_CLIENT_IDS.has(clientId),
      verificationUri: "/device",
    }),
  ],
});

export type Session = typeof auth.$Infer.Session;
