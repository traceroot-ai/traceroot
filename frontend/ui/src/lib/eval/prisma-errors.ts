/**
 * Prisma error probes.
 *
 * Deliberately duck-typed rather than `instanceof PrismaClientKnownRequestError`:
 * route tests swap `prisma` for an in-memory fake, and an `instanceof` check against
 * the generated client would then quietly stop matching, turning a handled conflict
 * back into the unhandled 500 these guards exist to prevent.
 */

/** True when `err` is a Prisma known-request error carrying `code` (e.g. "P2002"). */
export function isPrismaKnownError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/**
 * The constraint/field(s) a P2002 (or P2003) names, as a lowercase string. Postgres
 * reports the index name for a named `@@unique(map: ...)`, so callers can tell a
 * version-number collision from an idempotency-key collision.
 */
export function prismaErrorTarget(err: unknown): string {
  const target = (err as { meta?: { target?: unknown } } | null)?.meta?.target;
  if (Array.isArray(target)) return target.map(String).join(",").toLowerCase();
  if (typeof target === "string") return target.toLowerCase();
  return "";
}
