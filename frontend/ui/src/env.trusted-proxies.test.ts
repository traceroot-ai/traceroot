import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Asserts the real schema, deliberately in its own file with no vi.mock of
 * "@/env": every other env-touching test mocks that module, so a changed
 * default in env.ts would otherwise pass the whole suite with the line still
 * reported as covered. A private-range default here was rejected in review
 * because it silently breaks any deployment whose callers are observed on a
 * private address; this is the guard that keeps it rejected.
 */
describe("AUTH_TRUSTED_PROXY_CIDRS schema", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BETTER_AUTH_SECRET = "schema-default-test-secret-value";
    process.env.INTERNAL_API_SECRET = "schema-default-test-secret-value";
    delete process.env.AUTH_TRUSTED_PROXY_CIDRS;
  });

  it("defaults to blank, so an unconfigured deployment inherits the library default", async () => {
    const { env } = await import("./env");
    expect(env.AUTH_TRUSTED_PROXY_CIDRS).toBe("");
  });

  it("rejects an invalid CIDR when the config is parsed, not on the first auth request", async () => {
    process.env.AUTH_TRUSTED_PROXY_CIDRS = "10.0.0.0/8, not-a-cidr";
    await expect(import("./env")).rejects.toThrow(/AUTH_TRUSTED_PROXY_CIDRS|not-a-cidr/);
  });

  it("accepts a well-formed list", async () => {
    process.env.AUTH_TRUSTED_PROXY_CIDRS = "10.0.0.0/8, 172.16.0.0/12";
    const { env } = await import("./env");
    expect(env.AUTH_TRUSTED_PROXY_CIDRS).toBe("10.0.0.0/8, 172.16.0.0/12");
  });
});
