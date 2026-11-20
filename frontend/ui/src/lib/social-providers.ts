export const AGENTID_PROVIDER_ID = "agentid" as const;

export type SocialProvider = "google" | typeof AGENTID_PROVIDER_ID;

interface SocialProviderEnv {
  AUTH_GOOGLE_CLIENT_ID: string;
  AUTH_GOOGLE_CLIENT_SECRET: string;
  AUTH_AGENTID_CLIENT_ID: string;
  AUTH_AGENTID_CLIENT_SECRET: string;
}

const hasCredentials = (id: string, secret: string) => Boolean(id.trim() && secret.trim());

/** The social sign-in buttons to show, in display order. */
export function configuredSocialProviders(env: SocialProviderEnv): SocialProvider[] {
  const providers: SocialProvider[] = [];
  if (hasCredentials(env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET)) {
    providers.push("google");
  }
  if (hasCredentials(env.AUTH_AGENTID_CLIENT_ID, env.AUTH_AGENTID_CLIENT_SECRET)) {
    providers.push(AGENTID_PROVIDER_ID);
  }
  return providers;
}
