export const isStaff = (role: string | null | undefined) => role === "admin" || role === "support";
export const isRead = (method: string) => ["GET", "HEAD", "OPTIONS"].includes(method);
// Marks 403s the impersonation policy produced, so the banner can show them
// without confusing them with plan-entitlement refusals.
export const DENIED_HEADER = "x-impersonation-denied";

// Paths that can hand authority to another system are not customer data reads.
export function impersonationDenial(
  path: string,
  method: string,
  role: string | null | undefined,
): string | null {
  if (/^\/api\/(support|auth|cli|internal|public)(\/|$)/.test(path)) {
    return "Exit impersonation before managing accounts or credentials";
  }
  if (
    (/^\/api\/(github|slack)\//.test(path) && !/^\/api\/github\/status\/?$/.test(path)) ||
    /^\/api\/workspaces\/[^/]+\/slack\/install\/?$/.test(path)
  ) {
    return "Integration authorization is unavailable while impersonating";
  }
  if (path.includes("/api-keys")) return "Credentials are unavailable while impersonating";
  // Provider tests decrypt stored keys; changing a base URL can redirect those
  // keys on the next agent request. Neither staff tier may manage credentials.
  if (/^\/api\/workspaces\/[^/]+\/model-providers(\/|$)/.test(path) && !isRead(method))
    return "Provider credentials are unavailable while impersonating";
  if (role !== "admin" && !isRead(method)) return "Read-only while impersonating";
  return null;
}
