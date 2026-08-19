import { env } from "@/env";

export type SocialAuthProvider = "google" | "github";

export type EnabledSocialAuthProviders = Record<SocialAuthProvider, boolean>;

function socialProviderCredentials(clientId: string, clientSecret: string) {
  const trimmedClientId = clientId.trim();
  const trimmedClientSecret = clientSecret.trim();

  if (!trimmedClientId || !trimmedClientSecret) {
    return null;
  }

  return {
    clientId: trimmedClientId,
    clientSecret: trimmedClientSecret,
  };
}

export function getSocialAuthConfig() {
  const google = socialProviderCredentials(
    env.AUTH_GOOGLE_CLIENT_ID,
    env.AUTH_GOOGLE_CLIENT_SECRET,
  );
  const github = socialProviderCredentials(
    env.AUTH_GITHUB_CLIENT_ID,
    env.AUTH_GITHUB_CLIENT_SECRET,
  );

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
