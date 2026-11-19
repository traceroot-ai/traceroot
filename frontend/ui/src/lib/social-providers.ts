export type SocialProvider = "google";

interface SocialProviderEnv {
  AUTH_GOOGLE_CLIENT_ID: string;
  AUTH_GOOGLE_CLIENT_SECRET: string;
}

/** The social sign-in buttons to show, in display order. */
export function configuredSocialProviders(env: SocialProviderEnv): SocialProvider[] {
  const providers: SocialProvider[] = [];
  if (env.AUTH_GOOGLE_CLIENT_ID.trim() && env.AUTH_GOOGLE_CLIENT_SECRET.trim()) {
    providers.push("google");
  }
  return providers;
}
