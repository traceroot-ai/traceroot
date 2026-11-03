// Shared storage for better-auth's per-client rate limits. better-auth's
// default keeps counters in process memory, so every replica has its own
// budget and a restart clears it. With REDIS_URL set, the counters live in
// Redis and every replica draws from one budget.
//
// This is deliberately rateLimit.customStorage, not better-auth's
// secondaryStorage: the latter would also move sessions out of Postgres, which
// the CLI token exchange and backend session lookups read directly.
import Redis from "ioredis";
import type { BetterAuthRateLimitStorage } from "@better-auth/core";

const KEY_PREFIX = "traceroot:auth-rate-limit:";

// Fixed window: the first hit opens it with a TTL of `window`; every hit in it
// counts. Returns the count after this hit and the milliseconds left. The TTL
// is re-applied if it was ever lost so a key can never become permanent.
const CONSUME_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

type ConsumeClient = Pick<Redis, "eval" | "get" | "set">;

// One line a minute at most: an outage would otherwise log on every request.
let lastFailureLog = 0;
function logFailure(error: unknown): void {
  const now = Date.now();
  if (now - lastFailureLog < 60_000) return;
  lastFailureLog = now;
  console.error("[auth] rate-limit store unavailable, allowing requests:", error);
}

/**
 * Fails open: if Redis is unreachable the request is allowed and logged.
 * Locking every user out of sign-in during a cache outage is worse than a
 * brief window without throttling, and the edge WAF still applies.
 */
export function createRedisRateLimitStorage(
  client: () => ConsumeClient,
): BetterAuthRateLimitStorage {
  return {
    async consume(key, rule) {
      const windowMs = rule.window * 1000;
      try {
        const [count, ttlMs] = (await client().eval(
          CONSUME_SCRIPT,
          1,
          KEY_PREFIX + key,
          windowMs,
        )) as [number, number];
        if (count <= rule.max) return { allowed: true, retryAfter: null };
        return { allowed: false, retryAfter: Math.max(1, Math.ceil(ttlMs / 1000)) };
      } catch (error) {
        logFailure(error);
        return { allowed: true, retryAfter: null };
      }
    },
    // better-auth only falls back to get/set when consume is missing; they are
    // here because the storage type still requires them.
    async get(key) {
      try {
        const raw = await client().get(`${KEY_PREFIX}legacy:${key}`);
        return raw ? JSON.parse(raw) : null;
      } catch (error) {
        logFailure(error);
        return null;
      }
    },
    async set(key, value) {
      try {
        await client().set(`${KEY_PREFIX}legacy:${key}`, JSON.stringify(value), "EX", 3600);
      } catch (error) {
        logFailure(error);
      }
    },
  };
}

/**
 * Redis-backed storage when `redisUrl` is set, otherwise undefined so
 * better-auth keeps its in-memory default. The connection opens on first use,
 * so `next build` (which evaluates this module) never dials Redis.
 */
export function authRateLimitStorage(
  redisUrl: string | undefined,
): BetterAuthRateLimitStorage | undefined {
  if (!redisUrl?.trim()) return undefined;
  let redis: Redis | undefined;
  return createRedisRateLimitStorage(() => {
    if (!redis) {
      redis = new Redis(redisUrl, {
        // Bound the latency an unhealthy Redis adds to every auth request.
        commandTimeout: 500,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
      });
      // Without a listener ioredis rethrows connection errors as unhandled.
      redis.on("error", logFailure);
    }
    return redis;
  });
}
