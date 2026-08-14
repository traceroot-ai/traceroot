import { describe, it, expect, beforeEach } from "vitest";
import {
  checkMintRateLimit,
  rateLimitClientKey,
  __resetMintRateLimit,
  __mintWindowCount,
} from "./mint-rate-limit";

beforeEach(() => {
  __resetMintRateLimit();
});

describe("checkMintRateLimit", () => {
  it("allows up to max within the window, then blocks", () => {
    const t = 1000;
    expect(checkMintRateLimit("k", 2, 1000, t)).toBe(true);
    expect(checkMintRateLimit("k", 2, 1000, t)).toBe(true);
    expect(checkMintRateLimit("k", 2, 1000, t)).toBe(false);
  });

  it("resets once the window elapses", () => {
    expect(checkMintRateLimit("k", 1, 1000, 1000)).toBe(true); // window resets at 2000
    expect(checkMintRateLimit("k", 1, 1000, 1500)).toBe(false); // still in window
    expect(checkMintRateLimit("k", 1, 1000, 2000)).toBe(true); // new window
  });

  it("keys buckets independently", () => {
    expect(checkMintRateLimit("a", 1, 1000, 1000)).toBe(true);
    expect(checkMintRateLimit("b", 1, 1000, 1000)).toBe(true);
    expect(checkMintRateLimit("a", 1, 1000, 1000)).toBe(false);
  });

  it("bounds tracked windows under a same-window distinct-key flood", () => {
    const t = 1000;
    // All in one window (nothing expires), more distinct keys than the cap.
    for (let i = 0; i < 10_050; i++) {
      checkMintRateLimit(`key-${i}`, 5, 60_000, t);
    }
    expect(__mintWindowCount()).toBeLessThanOrEqual(10_000);
    // Still functional after eviction: a fresh key limits normally.
    expect(checkMintRateLimit("fresh", 1, 60_000, t)).toBe(true);
    expect(checkMintRateLimit("fresh", 1, 60_000, t)).toBe(false);
    expect(__mintWindowCount()).toBeLessThanOrEqual(10_000);
  });
});

describe("rateLimitClientKey", () => {
  it("prefers the last x-forwarded-for hop over a client-settable x-real-ip", () => {
    const key = rateLimitClientKey(
      new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }),
    );
    expect(key).toBe("9.9.9.9");
  });

  it("uses the LAST x-forwarded-for hop (ALB-appended client, not the spoofable leftmost)", () => {
    const key = rateLimitClientKey(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }));
    expect(key).toBe("3.3.3.3");
  });

  it("falls back to x-real-ip only when no x-forwarded-for is present", () => {
    expect(rateLimitClientKey(new Headers({ "x-real-ip": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("falls back to a shared bucket when no forwarding header is present", () => {
    expect(rateLimitClientKey(new Headers())).toBe("local");
  });
});
