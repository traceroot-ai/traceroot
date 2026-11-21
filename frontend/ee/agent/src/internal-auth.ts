import { createHash, timingSafeEqual } from "crypto";
import type { Context, MiddlewareHandler } from "hono";
import {
  isUsableSecret,
  INTERNAL_SECRET_HEADER,
  SYSTEM_CALL_HEADER,
} from "@traceroot/core/agent-service";
import { agentInternalSecret } from "./internal-secret.js";

/** Routes reachable without the internal credential. */
const OPEN_PATHS = new Set(["/health"]);

// Digests, not the raw strings: timingSafeEqual needs equal lengths, and
// hashing makes the comparison independent of the presented value's length.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function matchesSecret(presented: string | undefined, secret: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(secret));
}

/**
 * The agent service takes requests only from the platform's own services.
 * Every route except the health check needs the internal credential; the
 * identity headers are read by handlers only after this has passed.
 */
export function requireInternalSecret(): MiddlewareHandler {
  return async (c, next) => {
    if (OPEN_PATHS.has(c.req.path)) return next();
    const secret = agentInternalSecret();
    if (!isUsableSecret(secret)) {
      return c.json({ error: "service not configured" }, 503);
    }
    if (!matchesSecret(c.req.header(INTERNAL_SECRET_HEADER), secret)) {
      return c.json({ error: "forbidden" }, 403);
    }
    return next();
  };
}

/** Called once at startup: the service must not listen without a usable credential. */
export function assertInternalSecretConfigured(): void {
  if (!isUsableSecret(process.env.INTERNAL_API_SECRET)) {
    throw new Error(
      "INTERNAL_API_SECRET must be set to a non-placeholder value; generate one with `openssl rand -hex 32`",
    );
  }
}

export type CallerIdentity = { userId: string; system: boolean };

/**
 * Who the (already authenticated) call acts for: a user, or the platform
 * itself when it says so. Anything else — no user and no system marker, or
 * both — is not an identity, so the caller gets null and answers 400.
 */
export function callerIdentity(c: Context, opts: { allowSystem: boolean }): CallerIdentity | null {
  const userId = c.req.header("x-user-id") || "";
  const system = c.req.header(SYSTEM_CALL_HEADER) === "1";
  if (system) {
    return opts.allowSystem && !userId ? { userId: "", system: true } : null;
  }
  return userId ? { userId, system: false } : null;
}
