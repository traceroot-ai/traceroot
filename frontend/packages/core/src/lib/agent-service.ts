/**
 * What every caller of the agent service presents, and what the service
 * accepts: the one internal credential (`INTERNAL_API_SECRET`) shared with the
 * other server-side services, plus the identity of the request.
 *
 * Identity headers are only meaningful on a call that carries the credential.
 * A call made on the system's own behalf (no signed-in user) says so with
 * `SYSTEM_CALL_HEADER` rather than by leaving the user out.
 */

export const INTERNAL_SECRET_HEADER = "X-Internal-Secret";
export const SYSTEM_CALL_HEADER = "x-agent-system-call";

// Values this repository shipped as defaults in .env.example or
// docker-compose.prod.yml. They are public, so they are not secrets.
export const PUBLISHED_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "dev-internal-secret",
  "internal-secret",
  "your-better-auth-secret",
  "local-dev-secret-change-in-production",
  "changeme",
]);

/** Blank and published placeholder values are not usable as a credential. */
export function isUsableSecret(value: string | undefined): value is string {
  if (value === undefined || value.trim().length === 0) return false;
  return !PUBLISHED_SECRET_PLACEHOLDERS.has(value.trim().toLowerCase());
}

export interface AgentCallIdentity {
  /** The signed-in user the call acts for. Omit only with `system: true`. */
  userId?: string;
  workspaceId?: string;
  /** The call is made by the platform itself, not on behalf of a user. */
  system?: boolean;
}

/**
 * Headers for a request to the agent service. Reads the secret at call time so
 * the value is the one the process was started with; throws when it is not
 * configured rather than sending a request that cannot succeed.
 */
export function agentRequestHeaders(identity: AgentCallIdentity = {}): Record<string, string> {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!isUsableSecret(secret)) {
    throw new Error("INTERNAL_API_SECRET is not configured");
  }
  const headers: Record<string, string> = { [INTERNAL_SECRET_HEADER]: secret };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.workspaceId) headers["x-workspace-id"] = identity.workspaceId;
  if (identity.system) headers[SYSTEM_CALL_HEADER] = "1";
  return headers;
}
