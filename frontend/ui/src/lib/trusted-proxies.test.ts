import { getIPFromHeader } from "@better-auth/core/utils/ip";
import { describe, expect, it } from "vitest";
import { trustedProxyCidrs } from "./trusted-proxies";

describe("trustedProxyCidrs", () => {
  it("returns no trusted proxies when unset or blank", () => {
    // Blank must mean "inherit the library default", not a guessed range: a
    // guessed range silently breaks any deployment whose callers are observed
    // inside it. See the characterization tests below.
    expect(trustedProxyCidrs(undefined)).toEqual([]);
    expect(trustedProxyCidrs("")).toEqual([]);
    expect(trustedProxyCidrs("  ")).toEqual([]);
    expect(trustedProxyCidrs(",, ,")).toEqual([]);
  });

  it("parses and trims configured ranges", () => {
    expect(trustedProxyCidrs(" 10.0.0.0/16 , 203.0.113.0/24 ")).toEqual([
      "10.0.0.0/16",
      "203.0.113.0/24",
    ]);
  });

  it("rejects CIDRs better-auth cannot parse, naming them", () => {
    // better-auth warns by name and drops unparseable entries when the auth
    // context is created. If every entry were a typo the list would be empty
    // and resolution would revert to single-entry mode behind one warn line.
    expect(() => trustedProxyCidrs("10.0.0.0/16,nonsense,10.0.0.0/33")).toThrow(
      /nonsense, 10\.0\.0\.0\/33/,
    );
  });
});

/**
 * Characterization tests for the behaviour this config exists to control.
 *
 * These call better-auth's own resolver, so they document the contract rather
 * than our belief about it, and fail if a library upgrade changes it. Reasoning
 * about this from memory produced wrong conclusions twice.
 *
 * Use getIPFromHeader, never getIp: getIp short-circuits to 127.0.0.1 whenever
 * NODE_ENV is "test", so an assertion through it can never observe null.
 */
describe("better-auth client-address resolution", () => {
  it("trusts a lone entry when nothing is configured", () => {
    expect(getIPFromHeader("203.0.113.20", { trustedProxies: [] })).toBe("203.0.113.20");
  });

  it("cannot resolve a chain when nothing is configured", () => {
    // null does NOT mean "no limiting" — the caller falls into one shared
    // bucket, which is the failure this config addresses.
    expect(getIPFromHeader("198.51.100.7, 203.0.113.20", { trustedProxies: [] })).toBeNull();
  });

  it("resolves a chain to the rightmost entry once ranges are configured", () => {
    // Our edge appends the address it observed, so the prepended value is
    // ignored rather than making the chain unresolvable.
    expect(getIPFromHeader("198.51.100.7, 203.0.113.20", { trustedProxies: ["10.0.0.0/16"] })).toBe(
      "203.0.113.20",
    );
  });

  it("stops resolving a caller observed inside a configured range", () => {
    // The cost of configuring ranges, and the reason blank must stay empty: a
    // caller inside them is treated as a hop, not a caller.
    expect(getIPFromHeader("192.168.1.50", { trustedProxies: ["192.168.0.0/16"] })).toBeNull();
    expect(getIPFromHeader("192.168.1.50", { trustedProxies: [] })).toBe("192.168.1.50");
  });
});
