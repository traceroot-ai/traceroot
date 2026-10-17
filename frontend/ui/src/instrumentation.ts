/**
 * Next.js runs register() once when the server starts. Two things belong
 * here that would otherwise only happen on the first request that loads the
 * auth module (and Next swallows errors while preloading routes): parsing the
 * server config, so an invalid AUTH_TRUSTED_PROXY_CIDRS is reported in the
 * startup log with the entries named and every request fails until it is
 * fixed (a dev server exits; a production server stays up and answers 500),
 * and saying what was resolved from it, so a misconfigured or absent range
 * does not silently collapse multi-hop callers into one shared rate-limit
 * bucket.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { env } = await import("@/env");
  const { trustedProxyCidrs } = await import("@/lib/trusted-proxies");
  const cidrs = trustedProxyCidrs(env.AUTH_TRUSTED_PROXY_CIDRS);
  console.info(
    cidrs.length > 0
      ? `[auth] trusted proxies: ${cidrs.join(", ")} — x-forwarded-for resolves to the rightmost entry outside them`
      : "[auth] trusted proxies: none — only a single-entry x-forwarded-for is trusted; longer chains share one rate-limit bucket",
  );
}
