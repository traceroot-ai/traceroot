import { verifyProviderIdToken } from "@better-auth/core/oauth2";
import type { GenericOAuthConfig } from "better-auth/plugins/generic-oauth";
import { createRemoteJWKSet, decodeJwt } from "jose";

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

export function isAgentIdConfigured(env: AgentIdEnv): boolean {
  return Boolean(env.AUTH_AGENTID_CLIENT_ID.trim() && env.AUTH_AGENTID_CLIENT_SECRET.trim());
}

// AgentID, AgentMail's OpenID Connect issuer for AI agents. The email is always
// reported unverified, so better-auth never links an agent into an existing user.
export function agentIdProvider(env: AgentIdEnv): GenericOAuthConfig<"agentid"> {
  const clientId = env.AUTH_AGENTID_CLIENT_ID.trim();
  const idTokenConfig = {
    jwks: agentIdKeys,
    issuer: AGENTID_ISSUER,
    audience: clientId,
    algorithms: ["ES256"],
  };

  return {
    providerId: "agentid",
    name: "AgentID",
    clientId,
    clientSecret: env.AUTH_AGENTID_CLIENT_SECRET.trim(),
    authorizationUrl: AGENTID_ENDPOINTS.authorizationUrl,
    tokenUrl: AGENTID_ENDPOINTS.tokenUrl,
    tokenEndpointAuth: { method: "client_secret_basic" },
    pkce: true,
    scopes: ["openid", "email", "profile"],
    getUserInfo: async ({ idToken, accessToken }) => {
      if (!idToken || !accessToken) return null;
      const provider = { id: "agentid", idToken: idTokenConfig };
      if (!(await verifyProviderIdToken(provider, idToken))) return null;
      const { sub } = decodeJwt(idToken);

      const response = await fetch(AGENTID_ENDPOINTS.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => null);
      const profile: Record<string, unknown> | null = response?.ok
        ? await response.json().catch(() => null)
        : null;
      // userinfo must describe the agent the verified id_token names.
      if (!sub || profile?.sub !== sub || typeof profile.email !== "string") return null;

      const name = typeof profile.name === "string" && profile.name ? profile.name : undefined;
      return {
        ...profile,
        id: sub,
        email: profile.email,
        emailVerified: false,
        name: name ?? profile.email.split("@")[0],
      };
    },
  };
}
