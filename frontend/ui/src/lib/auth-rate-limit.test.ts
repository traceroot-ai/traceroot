import { afterEach, describe, expect, it, vi } from "vitest";

// Counts connections without opening one; eval answers like a first hit.
const redisConstructed = vi.hoisted(() => vi.fn());
vi.mock("ioredis", () => ({
  default: class {
    constructor(...args: unknown[]) {
      redisConstructed(...args);
    }
    on() {}
    eval = async () => [1, 1000];
  },
}));

import { authRateLimitStorage, createRedisRateLimitStorage } from "./auth-rate-limit";

const rule = { window: 3600, max: 2 };

function fakeClient(reply: () => Promise<unknown>) {
  const client = { eval: vi.fn(reply), get: vi.fn(), set: vi.fn() };
  return { client, storage: createRedisRateLimitStorage(() => client as never) };
}

afterEach(() => vi.restoreAllMocks());

describe("createRedisRateLimitStorage", () => {
  it("runs one atomic script per request, namespaced and windowed in ms", async () => {
    const { client, storage } = fakeClient(async () => [1, 3_600_000]);
    await storage.consume!("198.51.100.7|/sign-up/email", rule);
    expect(client.eval).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("INCR"),
      1,
      "traceroot:auth-rate-limit:198.51.100.7|/sign-up/email",
      3_600_000,
    );
  });

  it("allows up to max and then reports the seconds left in the window", async () => {
    const replies = [
      [1, 3_600_000],
      [2, 3_000_000],
      [3, 2_999_001],
    ];
    const { storage } = fakeClient(async () => replies.shift());
    expect(await storage.consume!("k", rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await storage.consume!("k", rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await storage.consume!("k", rule)).toEqual({ allowed: false, retryAfter: 3000 });
  });

  it("never asks a client to retry in zero seconds", async () => {
    const { storage } = fakeClient(async () => [5, 10]);
    expect(await storage.consume!("k", rule)).toEqual({ allowed: false, retryAfter: 1 });
  });

  it("fails open, logging at most once a minute, when Redis is down", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { storage } = fakeClient(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await storage.consume!("k", rule)).toEqual({ allowed: true, retryAfter: null });
    expect(await storage.consume!("k", rule)).toEqual({ allowed: true, retryAfter: null });
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe("legacy get/set", () => {
  // Only reached if better-auth ever drops consume; still namespaced and safe.
  it("round-trips a namespaced entry that expires", async () => {
    const { client, storage } = fakeClient(async () => [1, 1]);
    const entry = { key: "k", count: 2, lastRequest: 1700000000000 };
    await storage.set("k", entry);
    expect(client.set).toHaveBeenCalledWith(
      "traceroot:auth-rate-limit:legacy:k",
      JSON.stringify(entry),
      "EX",
      3600,
    );
    client.get.mockResolvedValueOnce(JSON.stringify(entry)).mockResolvedValueOnce(null);
    expect(await storage.get("k")).toEqual(entry);
    expect(await storage.get("k")).toBeNull();
  });

  it("treats a Redis failure as no entry and never throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, storage } = fakeClient(async () => [1, 1]);
    client.get.mockRejectedValue(new Error("down"));
    client.set.mockRejectedValue(new Error("down"));
    expect(await storage.get("k")).toBeNull();
    await expect(storage.set("k", { key: "k", count: 1, lastRequest: 1 })).resolves.toBeUndefined();
  });
});

describe("authRateLimitStorage", () => {
  it("leaves better-auth on its memory default when Redis is not configured", () => {
    expect(authRateLimitStorage(undefined)).toBeUndefined();
    expect(authRateLimitStorage("  ")).toBeUndefined();
  });

  it("does not connect until first use, then reuses one connection", async () => {
    const storage = authRateLimitStorage("redis://localhost:1/0");
    expect(redisConstructed).not.toHaveBeenCalled();
    await storage!.consume!("k", rule);
    await storage!.consume!("k", rule);
    expect(redisConstructed).toHaveBeenCalledOnce();
    expect(redisConstructed.mock.calls[0][0]).toBe("redis://localhost:1/0");
  });
});
