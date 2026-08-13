import { describe, it, expect, vi, beforeEach } from "vitest";

const findUniqueMock = vi.fn();
vi.mock("@traceroot/core", () => ({
  prisma: { session: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
}));

import { resolveSessionFromToken } from "./internal-session";

beforeEach(() => {
  findUniqueMock.mockReset();
});

describe("resolveSessionFromToken", () => {
  it("returns the user for a live (unexpired) session, looked up by token", async () => {
    findUniqueMock.mockResolvedValue({
      expiresAt: new Date(Date.now() + 60_000),
      user: { id: "u1", email: "u@example.com" },
    });

    await expect(resolveSessionFromToken("tok")).resolves.toEqual({
      user: { id: "u1", email: "u@example.com" },
    });
    expect(findUniqueMock.mock.calls[0][0].where).toEqual({ token: "tok" });
  });

  it("returns null for an expired session", async () => {
    findUniqueMock.mockResolvedValue({
      expiresAt: new Date(Date.now() - 1_000),
      user: { id: "u1", email: "u@example.com" },
    });

    await expect(resolveSessionFromToken("tok")).resolves.toBeNull();
  });

  it("returns null when the token is unknown", async () => {
    findUniqueMock.mockResolvedValue(null);

    await expect(resolveSessionFromToken("nope")).resolves.toBeNull();
  });

  it("propagates a database error — an outage is a 500, not a bad token", async () => {
    findUniqueMock.mockRejectedValue(new Error("db down"));

    await expect(resolveSessionFromToken("tok")).rejects.toThrow("db down");
  });
});
