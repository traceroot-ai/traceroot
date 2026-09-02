/**
 * verifyInternalSecret guards the internal (server-to-server) API routes, which
 * can create resources on behalf of any user. These tests pin two properties:
 *
 * 1. Accept/reject behavior: only the exact configured secret is accepted, and
 *    a missing header or blank configured secret fails closed.
 * 2. The comparison is constant-time (crypto.timingSafeEqual over fixed-length
 *    digests), so response timing cannot be used to recover the secret
 *    byte-by-byte. The spy assertion fails if this is ever refactored back to
 *    a short-circuiting string comparison.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { timingSafeEqual } from "crypto";

const envMock = vi.hoisted(() => ({ INTERNAL_API_SECRET: "test-secret" }));

vi.mock("@/env", () => ({ env: envMock }));
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@traceroot/core", () => ({
  prisma: {},
  hasMinRole: vi.fn(),
}));
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import { verifyInternalSecret } from "@/lib/auth-helpers";

function requestWithSecret(secret?: string): Request {
  const headers: Record<string, string> = {};
  if (secret !== undefined) headers["X-Internal-Secret"] = secret;
  return new Request("http://localhost/api/internal/test", { headers });
}

describe("verifyInternalSecret", () => {
  beforeEach(() => {
    envMock.INTERNAL_API_SECRET = "test-secret";
    vi.mocked(timingSafeEqual).mockClear();
  });

  it("accepts the correct secret", () => {
    expect(verifyInternalSecret(requestWithSecret("test-secret"))).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(verifyInternalSecret(requestWithSecret("test-secreX"))).toBe(false);
  });

  it("rejects wrong secrets of different lengths without throwing", () => {
    expect(verifyInternalSecret(requestWithSecret("x"))).toBe(false);
    expect(verifyInternalSecret(requestWithSecret("test-secret-but-longer"))).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(verifyInternalSecret(requestWithSecret(undefined))).toBe(false);
  });

  it("rejects an empty header", () => {
    expect(verifyInternalSecret(requestWithSecret(""))).toBe(false);
  });

  it("fails closed when the configured secret is blank", () => {
    // env validation rejects a blank INTERNAL_API_SECRET at boot, so this is
    // unreachable in a running app — pinned anyway so the guard survives any
    // future loosening of that validation.
    envMock.INTERNAL_API_SECRET = "";
    expect(verifyInternalSecret(requestWithSecret(""))).toBe(false);
    expect(verifyInternalSecret(requestWithSecret("anything"))).toBe(false);
  });

  it("compares via crypto.timingSafeEqual, not string equality", () => {
    verifyInternalSecret(requestWithSecret("test-secret"));
    verifyInternalSecret(requestWithSecret("test-secreX"));
    expect(vi.mocked(timingSafeEqual)).toHaveBeenCalledTimes(2);
  });
});
