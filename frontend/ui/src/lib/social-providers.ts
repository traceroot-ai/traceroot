export const AGENTID_PROVIDER_ID = "agentid" as const;

export type SocialProvider = "github" | "google" | typeof AGENTID_PROVIDER_ID;

interface SocialProviderEnv {
  // Optional so that a caller (or a test's stand-in environment) that predates
  // GitHub sign-in reads as GitHub not configured.
  AUTH_GITHUB_CLIENT_ID?: string;
  AUTH_GITHUB_CLIENT_SECRET?: string;
  AUTH_GOOGLE_CLIENT_ID: string;
  AUTH_GOOGLE_CLIENT_SECRET: string;
  AUTH_AGENTID_CLIENT_ID: string;
  AUTH_AGENTID_CLIENT_SECRET: string;
}

/** Trimmed credentials, or null when either half is missing or blank. */
function credentials(clientId: string | undefined, clientSecret: string | undefined) {
  const id = clientId?.trim() ?? "";
  const secret = clientSecret?.trim() ?? "";
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

/** The social sign-in buttons to show, in display order. */
export function configuredSocialProviders(env: SocialProviderEnv): SocialProvider[] {
  const providers: SocialProvider[] = [];
  if (credentials(env.AUTH_GITHUB_CLIENT_ID, env.AUTH_GITHUB_CLIENT_SECRET)) {
    providers.push("github");
  }
  if (credentials(env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET)) {
    providers.push("google");
  }
  if (credentials(env.AUTH_AGENTID_CLIENT_ID, env.AUTH_AGENTID_CLIENT_SECRET)) {
    providers.push(AGENTID_PROVIDER_ID);
  }
  return providers;
}

/**
 * better-auth's built-in social providers that are configured, with trimmed
 * credentials. One left out is not registered at all, so its sign-in cannot
 * start and dead-end at the provider. GitHub signs a person in to traceroot
 * only: its provider asks for their profile and email (read:user, user:email),
 * never repository access, which is the GitHub App's job when a workspace
 * connects a repository.
 */
export function socialProviderOptions(env: SocialProviderEnv) {
  const github = credentials(env.AUTH_GITHUB_CLIENT_ID, env.AUTH_GITHUB_CLIENT_SECRET);
  const google = credentials(env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET);
  return {
    ...(github && { github }),
    ...(google && { google }),
  };
}
