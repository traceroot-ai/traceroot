import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { AGENTID_PROVIDER_ID } from "@/lib/social-providers";

interface AgentIdEnv {
  AUTH_AGENTID_CLIENT_ID: string;
  AUTH_AGENTID_CLIENT_SECRET: string;
}

export const AGENTID_ISSUER = "https://auth.agentid.com";

// Pinned rather than discovered: better-auth fetches discovery at init with no
// timeout, so a slow AgentID would stall every sign-in method.
export const AGENTID_ENDPOINTS = {
  authorizationUrl: `${AGENTID_ISSUER}/v0/authorize`,
  tokenUrl: `${AGENTID_ISSUER}/v0/token`,
  userInfoUrl: `${AGENTID_ISSUER}/v0/userinfo`,
  jwksUrl: `${AGENTID_ISSUER}/v0/jwks.json`,
} as const;

// Fetched on first use and cached; jose bounds each fetch with a timeout.
const agentIdKeys = createRemoteJWKSet(new URL(AGENTID_ENDPOINTS.jwksUrl));

// AgentID, AgentMail's OpenID Connect issuer for AI agents. The email is always
// reported unverified, so better-auth never links an agent into an existing user.
export function agentIdProvider(env: AgentIdEnv): GenericOAuthConfig<typeof AGENTID_PROVIDER_ID> {
  const clientId = env.AUTH_AGENTID_CLIENT_ID.trim();

  return {
    providerId: AGENTID_PROVIDER_ID,
    name: "AgentID",
    clientId,
    clientSecret: env.AUTH_AGENTID_CLIENT_SECRET.trim(),
    authorizationUrl: AGENTID_ENDPOINTS.authorizationUrl,
    tokenUrl: AGENTID_ENDPOINTS.tokenUrl,
    tokenEndpointAuth: { method: "client_secret_basic" },
    pkce: true,
    scopes: ["openid", "email", "profile"],
    getUserInfo: async ({ idToken, accessToken }) => {
      // jose skips the audience check when it is empty, so a blank client id fails closed.
      if (!clientId || !idToken || !accessToken) return null;
      // Same claims and clock skew as better-auth's own id_token verifier.
      const verified = await jwtVerify(idToken, agentIdKeys, {
        issuer: AGENTID_ISSUER,
        audience: clientId,
        algorithms: ["ES256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
        clockTolerance: 30,
      }).catch(() => null);
      const sub = verified?.payload.sub;
      if (!sub) return null;

      const response = await fetch(AGENTID_ENDPOINTS.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(5_000),
      }).catch(() => null);
      const profile: Record<string, unknown> | null = response?.ok
        ? await response.json().catch(() => null)
        : null;
      // userinfo must describe the agent the verified id_token names.
      if (profile?.sub !== sub || typeof profile.email !== "string" || !profile.email) return null;

      const name = typeof profile.name === "string" && profile.name ? profile.name : undefined;
      return {
        id: sub,
        email: profile.email,
        emailVerified: false,
        name: name ?? profile.email.split("@")[0],
      };
    },
  };
}
