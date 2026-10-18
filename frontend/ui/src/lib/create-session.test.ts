import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as { AUTH_TRUSTED_PROXY_CIDRS?: string },
  create: vi.fn(),
}));

// The real env module parses the whole server schema at import and throws here.
vi.mock("@/env", () => ({ env: mocks.env }));

import { clientIpAddress, createSession } from "./create-session";
import { rateLimitClientKey } from "./mint-rate-limit";
import { SESSION_EXPIRES_IN_SECONDS } from "./session-config";

const db = { session: { create: mocks.create } } as unknown as Parameters<typeof createSession>[0];

function headers(init: Record<string, string>) {
  return new Headers(init);
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.create.mockImplementation(async ({ data }: { data: unknown }) => data);
  delete mocks.env.AUTH_TRUSTED_PROXY_CIDRS;
});

describe("createSession", () => {
  it("writes a real login: null impersonatedBy, a 256-bit token, the shared expiry", async () => {
    const before = Date.now();
    const session = (await createSession(db, { userId: "u1" })) as {
      id: string;
      token: string;
      userId: string;
      expiresAt: Date;
      impersonatedBy: string | null;
      ipAddress: string | null;
      userAgent: string | null;
    };

    expect(session.userId).toBe("u1");
    // resolveSessionFromToken rejects an impersonated session outright, so a
    // handoff session with this set would mint no CLI access token at all.
    expect(session.impersonatedBy).toBeNull();
    // 32 random bytes as hex.
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    const expected = before + SESSION_EXPIRES_IN_SECONDS * 1000;
    expect(session.expiresAt.getTime()).toBeGreaterThanOrEqual(expected);
    expect(session.expiresAt.getTime()).toBeLessThan(expected + 5000);
    // No request supplied: both columns stay null rather than being invented.
    expect(session.ipAddress).toBeNull();
    expect(session.userAgent).toBeNull();
  });

  it("issues a distinct token per call", async () => {
    const a = (await createSession(db, { userId: "u1" })) as { token: string };
    const b = (await createSession(db, { userId: "u1" })) as { token: string };
    expect(a.token).not.toBe(b.token);
  });

  it("copies the user agent so Active Sessions can label the CLI", async () => {
    const session = (await createSession(db, {
      userId: "u1",
      headers: headers({ "user-agent": "traceroot-cli/0.7.0", "x-forwarded-for": "203.0.113.7" }),
    })) as { userAgent: string | null; ipAddress: string | null };

    // sessionLabel keys off this prefix; drop it and a handoff session reads
    // "Unknown device" while a device-flow session reads "TraceRoot CLI".
    expect(session.userAgent).toBe("traceroot-cli/0.7.0");
    expect(session.ipAddress).toBe("203.0.113.7");
  });

  it("records the staff user on an impersonation session", async () => {
    const session = (await createSession(db, {
      userId: "customer",
      impersonatedBy: "staff",
    })) as { impersonatedBy: string | null };
    expect(session.impersonatedBy).toBe("staff");
  });

  it("passes the session row through to the caller's Prisma client", async () => {
    await createSession(db, { userId: "u1" });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].data.userId).toBe("u1");
  });
});

describe("clientIpAddress", () => {
  it("resolves a single-entry forwarded header", () => {
    expect(clientIpAddress(headers({ "x-forwarded-for": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("does NOT take the last hop the way the rate limiter does", () => {
    // Multi-hop with no trusted proxies configured: better-auth refuses to pick
    // an address, so the column must not hold the limiter's bucket key.
    const h = headers({ "x-forwarded-for": "198.51.100.4, 203.0.113.9" });
    expect(rateLimitClientKey(h)).toBe("203.0.113.9");
    expect(clientIpAddress(h)).not.toBe("203.0.113.9");
  });

  it("walks the chain from the right past AUTH_TRUSTED_PROXY_CIDRS hops", () => {
    mocks.env.AUTH_TRUSTED_PROXY_CIDRS = "203.0.113.0/24";
    expect(clientIpAddress(headers({ "x-forwarded-for": "198.51.100.4, 203.0.113.9" }))).toBe(
      "198.51.100.4",
    );
  });

  it("normalises IPv6 to a /64, which the limiter's key does not", () => {
    mocks.env.AUTH_TRUSTED_PROXY_CIDRS = "203.0.113.0/24";
    const h = headers({ "x-forwarded-for": "2001:db8::dead:beef, 203.0.113.9" });
    expect(clientIpAddress(h)).toBe("2001:0db8:0000:0000:0000:0000:0000:0000");
    expect(rateLimitClientKey(h)).toBe("203.0.113.9");
  });

  it("ignores x-real-ip, which the limiter falls back to", () => {
    // better-auth reads x-forwarded-for only; x-real-ip is forgeable here.
    const h = headers({ "x-real-ip": "203.0.113.9" });
    expect(rateLimitClientKey(h)).toBe("203.0.113.9");
    expect(clientIpAddress(h)).not.toBe("203.0.113.9");
  });

  it("rejects a bad trusted-proxy configuration rather than silently widening", () => {
    mocks.env.AUTH_TRUSTED_PROXY_CIDRS = "not-a-cidr";
    expect(() => clientIpAddress(headers({ "x-forwarded-for": "198.51.100.4" }))).toThrow(
      /invalid CIDRs/,
    );
  });
});
