import { prisma } from "./prisma.js";
import { decryptKey } from "./encryption.js";

/** Cache: `${workspaceId}:${provider}` → { key, expiresAt } */
const keyCache = new Map<string, { key: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;
// Sweep expired entries when the cache grows past this size — bounds memory
// without paying a sweep cost on every lookup.
const CACHE_SWEEP_AT = 256;

function evictExpired(now: number): void {
  for (const [k, v] of keyCache) {
    if (v.expiresAt <= now) keyCache.delete(k);
  }
}

/**
 * Resolve an API key for a workspace + provider.
 * Checks BYOK (modelProvider table) first, then falls back to env var.
 * Throws if neither source produces a key — silently returning "" would let
 * SDK constructors accept an empty string and fail later with a misleading
 * authentication error far from the configuration mistake.
 *
 * @param workspaceId - workspace to look up BYOK for
 * @param provider    - "anthropic" | "openai" (matches modelProvider.provider in DB)
 * @param envVar      - env var name to fall back to (e.g. "ANTHROPIC_API_KEY")
 */
export async function resolveWorkspaceApiKey(
  workspaceId: string,
  provider: string,
  envVar: string,
): Promise<string> {
  const now = Date.now();
  const cacheKey = `${workspaceId}:${provider}`;
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.key;
  }

  if (keyCache.size >= CACHE_SWEEP_AT) evictExpired(now);

  if (workspaceId) {
    try {
      const row = await prisma.modelProvider.findFirst({
        where: { workspaceId, provider, enabled: true },
        select: { keyCipher: true },
      });
      if (row?.keyCipher) {
        const key = decryptKey(row.keyCipher);
        keyCache.set(cacheKey, { key, expiresAt: now + CACHE_TTL_MS });
        return key;
      }
    } catch (err) {
      console.warn(`[resolveWorkspaceApiKey] DB lookup failed for ${provider}:`, err);
    }
  }

  const envKey = process.env[envVar];
  if (!envKey) {
    throw new Error(
      `No API key configured for provider "${provider}". Set ${envVar} or configure a BYOK key in workspace settings.`,
    );
  }
  return envKey;
}
