import { findInvalidTrustedProxies } from "@better-auth/core/utils/ip";

/**
 * Parses the proxy ranges better-auth uses to resolve the client address.
 *
 * Why this matters: better-auth reads x-forwarded-for and, with no trusted
 * proxies configured, trusts it only when it holds exactly one entry. A longer
 * chain resolves to null, and a null address does NOT disable rate limiting —
 * every such request shares one bucket per path, keyed "no-trusted-ip". Configuring
 * ranges switches resolution to walking the chain from the right, skipping
 * trusted hops, and taking the first entry outside them, so a caller who
 * prepends values is ignored rather than collapsed into that shared bucket.
 *
 * Blank means no trusted proxies, which is the library's own default and the
 * right one to inherit. Configuring ranges is not free: an address INSIDE them
 * is treated as a hop rather than a caller, so a deployment whose clients are
 * observed on private addresses — a LAN behind nginx, or Kubernetes SNAT-ing to
 * a node address — would have those callers skipped and land in the very shared
 * bucket this exists to avoid. Set this only for a deployment whose callers
 * arrive from outside the configured ranges.
 *
 * @param raw - Comma-separated CIDRs, typically AUTH_TRUSTED_PROXY_CIDRS.
 * @returns The configured ranges, or an empty list when unset.
 * @throws If any entry is not a CIDR better-auth can parse. The library logs a
 *   warning naming the invalid entries when the auth context is created, then
 *   continues with them dropped; if every entry were a typo the list would be
 *   empty and resolution would revert to single-entry mode behind one warn
 *   line. Throwing turns that into a failure. Note where it surfaces: Next.js
 *   swallows errors while preloading routes, so this fails on the first
 *   request that loads the auth module, not at container start. auth.test.ts
 *   pins that the throw reaches the import.
 */
export function trustedProxyCidrs(raw: string | undefined): string[] {
  const configured = (raw ?? "")
    .split(",")
    .map((cidr) => cidr.trim())
    .filter(Boolean);

  const invalid = findInvalidTrustedProxies(configured);
  if (invalid.length > 0) {
    throw new Error(`AUTH_TRUSTED_PROXY_CIDRS contains invalid CIDRs: ${invalid.join(", ")}`);
  }

  return configured;
}
