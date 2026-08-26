/**
 * A value published in this repository must never be usable as a secret.
 *
 * .env.example and docker-compose.prod.yml both shipped working values for
 * BETTER_AUTH_SECRET and INTERNAL_API_SECRET. BETTER_AUTH_SECRET signs
 * sessions, so a deployment still carrying the published value can be handed
 * forged session cookies by anyone who has read this repository. `min(1)` alone
 * accepted them, since they are not empty.
 *
 * The equivalent check for the Python services lives in backend/shared/config.py.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const PUBLISHED = [
  "dev-internal-secret",
  "internal-secret",
  "your-better-auth-secret",
  "local-dev-secret-change-in-production",
  "changeme",
];

const GENERATED = "a".repeat(64);

// env.ts validates process.env at import time, so every access has to happen
// after the environment is stubbed -- hence dynamic imports throughout.

/** Import env.ts fresh, with the whole server schema satisfied except overrides. */
async function loadEnv(overrides: Record<string, string> = {}) {
  vi.resetModules();
  vi.stubEnv("BETTER_AUTH_SECRET", GENERATED);
  vi.stubEnv("INTERNAL_API_SECRET", GENERATED);
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  return import("../env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("authSecret", () => {
  it.each(PUBLISHED)("rejects the published value %s", async (placeholder) => {
    const { authSecret } = await loadEnv();
    expect(authSecret().safeParse(placeholder).success).toBe(false);
  });

  it("rejects a published value regardless of case or padding", async () => {
    const { authSecret } = await loadEnv();
    expect(authSecret().safeParse("  Local-Dev-Secret-Change-In-Production ").success).toBe(false);
  });

  it.each(["", "   ", "\t\n"])("rejects the blank value %j", async (blank) => {
    const { authSecret } = await loadEnv();
    expect(authSecret().safeParse(blank).success).toBe(false);
  });

  it("accepts a generated secret", async () => {
    const { authSecret } = await loadEnv();
    expect(authSecret().safeParse(GENERATED).success).toBe(true);
  });

  it("keeps an operator value byte for byte", async () => {
    // The Python services compare this exact string, so trimming it here alone
    // would reject every internal request when the value carries whitespace.
    const { authSecret } = await loadEnv();
    const padded = `  ${GENERATED}  `;
    const result = authSecret().safeParse(padded);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(padded);
    }
  });

  it("rejects a padded placeholder too", async () => {
    const { authSecret } = await loadEnv();
    expect(authSecret().safeParse("  changeme  ").success).toBe(false);
  });

  it("explains how to generate one", async () => {
    const { authSecret } = await loadEnv();
    const result = authSecret().safeParse("changeme");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("openssl rand -hex 32");
    }
  });
});

describe("the server schema actually uses it", () => {
  it("boots when both secrets are generated", async () => {
    await expect(loadEnv()).resolves.toBeDefined();
  });

  it.each(["BETTER_AUTH_SECRET", "INTERNAL_API_SECRET"])(
    "refuses to boot when %s is the published value",
    async (key) => {
      await expect(loadEnv({ [key]: "local-dev-secret-change-in-production" })).rejects.toThrow();
    },
  );
});
