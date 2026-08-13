import { describe, it, expect, beforeEach } from "vitest";
import { checkMintRateLimit, rateLimitClientKey, __resetMintRateLimit } from "./mint-rate-limit";

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
});

describe("rateLimitClientKey", () => {
  it("prefers x-real-ip", () => {
    const key = rateLimitClientKey(
      new Headers({ "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }),
    );
    expect(key).toBe("1.2.3.4");
  });

  it("uses the LAST x-forwarded-for hop (ALB-appended client, not the spoofable leftmost)", () => {
    const key = rateLimitClientKey(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" }));
    expect(key).toBe("3.3.3.3");
  });

  it("falls back to a shared bucket when no forwarding header is present", () => {
    expect(rateLimitClientKey(new Headers())).toBe("local");
  });
});
