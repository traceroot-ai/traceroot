import { env } from "@/env";

export type SocialAuthProvider = "google" | "github";

export type EnabledSocialAuthProviders = Record<SocialAuthProvider, boolean>;

export function getSocialAuthConfig() {
  const google =
    env.AUTH_GOOGLE_CLIENT_ID.trim() && env.AUTH_GOOGLE_CLIENT_SECRET.trim()
      ? {
          clientId: env.AUTH_GOOGLE_CLIENT_ID,
          clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET,
        }
      : null;

  const github =
    env.AUTH_GITHUB_CLIENT_ID.trim() && env.AUTH_GITHUB_CLIENT_SECRET.trim()
      ? {
          clientId: env.AUTH_GITHUB_CLIENT_ID,
          clientSecret: env.AUTH_GITHUB_CLIENT_SECRET,
        }
      : null;

  return {
    enabledProviders: {
      google: Boolean(google),
      github: Boolean(github),
    } satisfies EnabledSocialAuthProviders,
    socialProviders: {
      ...(google ? { google } : {}),
      ...(github ? { github } : {}),
    },
  };
}
