import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logRefreshTokenReuse,
  oauthRefreshReuseLog,
  storedRefreshToken,
  type RefreshTokenLookup,
} from "./refresh-reuse-log";

vi.mock("@traceroot/core", () => ({ prisma: {} }));

const NOW = new Date("2026-11-24T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const inSeconds = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
afterEach(() => warn.mockClear());

const rotated = (rotatedSecondsAgo: number, replayUntil: Date | null) => ({
  clientId: "client-1",
  revoked: ago(rotatedSecondsAgo),
  rotatedAt: ago(rotatedSecondsAgo),
  rotationReplayExpiresAt: replayUntil,
});

describe("refresh token reuse logging", () => {
  it("looks a token up in the provider's stored form: SHA-256, base64url, no padding", () => {
    const expected = createHash("sha256").update("abc").digest("base64").replace(/=+$/, "");
    expect(storedRefreshToken("abc")).toBe(expected.replace(/\+/g, "-").replace(/\//g, "_"));
  });

  it("logs a reuse inside the window with its client and age, never the token", async () => {
    const lookup = vi.fn<RefreshTokenLookup>(async () => rotated(95, inSeconds(3505)));
    await logRefreshTokenReuse("secret-refresh-token", lookup, NOW);
    expect(lookup).toHaveBeenCalledWith(storedRefreshToken("secret-refresh-token"));
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[oauth] refresh token reused: client_id=client-1 age_s=95 within_reuse_window=true",
    );
    expect(String(warn.mock.calls[0][0])).not.toContain("secret-refresh-token");
  });

  it("logs a reuse after the window as outside it", async () => {
    await logRefreshTokenReuse("t", async () => rotated(4000, ago(400)), NOW);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[oauth] refresh token reused: client_id=client-1 age_s=4000 within_reuse_window=false",
    );
  });

  it("logs nothing for a live token or an unknown one", async () => {
    const live = { clientId: "c", revoked: null, rotatedAt: null, rotationReplayExpiresAt: null };
    await logRefreshTokenReuse("t", async () => live, NOW);
    await logRefreshTokenReuse("t", async () => null, NOW);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the reuse log hook", () => {
  const lookup = vi.fn<RefreshTokenLookup>(async () => rotated(10, inSeconds(10)));
  const [hook] = oauthRefreshReuseLog(lookup).hooks.before;
  const run = (body: Record<string, unknown>) =>
    (hook.handler as unknown as (c: unknown) => Promise<unknown>)({ body, context: {} });

  afterEach(() => lookup.mockClear());

  it("matches only the token endpoint", () => {
    expect(hook.matcher({ path: "/oauth2/token" } as never)).toBe(true);
    expect(hook.matcher({ path: "/oauth2/revoke" } as never)).toBe(false);
  });

  it("checks refresh grants only and never changes the request", async () => {
    expect(await run({ grant_type: "refresh_token", refresh_token: "r" })).toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    await run({ grant_type: "authorization_code", code: "c" });
    await run({ grant_type: "refresh_token" });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not fail the request when the lookup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    lookup.mockRejectedValueOnce(new Error("db down"));
    await expect(run({ grant_type: "refresh_token", refresh_token: "r" })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
