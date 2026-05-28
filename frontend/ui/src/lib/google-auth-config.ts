import "server-only";

import { env } from "@/env";

export function isGoogleAuthConfigured() {
  return Boolean(env.AUTH_GOOGLE_CLIENT_ID.trim() && env.AUTH_GOOGLE_CLIENT_SECRET.trim());
}

export function getGoogleAuthProviderConfig() {
  if (!isGoogleAuthConfigured()) {
    return undefined;
  }

  return {
    google: {
      clientId: env.AUTH_GOOGLE_CLIENT_ID.trim(),
      clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET.trim(),
    },
  };
}
