import { prisma } from "./prisma";
import { decryptKey } from "./encryption";

/** Cache: `${workspaceId}:${provider}` → { key, expiresAt } */
const keyCache = new Map<string, { key: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;
const CACHE_SWEEP_AT = 256;

function evictExpired(now: number): void {
  for (const [k, v] of keyCache) {
    if (v.expiresAt <= now) keyCache.delete(k);
  }
}

/**
 * Resolve an API key for a workspace + model-provider row label.
 * Checks BYOK (`model_providers.provider` equals `provider`) first, then env.
 *
 * @param workspaceId - workspace to look up BYOK for
 * @param provider    - value of `ModelProvider.provider` (e.g. user label or legacy `"openai"`)
 * @param envVar      - env var name to fall back to (e.g. `ANTHROPIC_API_KEY`)
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
