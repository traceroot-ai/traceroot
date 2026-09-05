import { describe, expect, it } from "vitest";

/**
 * Asserts the real schema, deliberately in its own file with no vi.mock of
 * "@/env": every other env-touching test mocks that module, so a changed
 * default in env.ts would otherwise pass the whole suite with the line still
 * reported as covered. A private-range default here was rejected in review
 * because it silently breaks any deployment whose callers are observed on a
 * private address; this is the guard that keeps it rejected.
 */
describe("AUTH_TRUSTED_PROXY_CIDRS schema default", () => {
  it("is blank, so an unconfigured deployment inherits the library default", async () => {
    process.env.BETTER_AUTH_SECRET = "schema-default-test-secret-value";
    process.env.INTERNAL_API_SECRET = "schema-default-test-secret-value";
    delete process.env.AUTH_TRUSTED_PROXY_CIDRS;
    const { env } = await import("./env");
    expect(env.AUTH_TRUSTED_PROXY_CIDRS).toBe("");
  });
});
