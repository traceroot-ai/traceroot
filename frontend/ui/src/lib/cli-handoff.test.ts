import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("@traceroot/core", () => ({
  prisma: { cliHandoff: { deleteMany: (...a: unknown[]) => mocks.deleteMany(...a) } },
}));

import {
  HANDOFF_TTL_SECONDS,
  generateHandoffCode,
  hashHandoffCode,
  pruneExpiredHandoffs,
} from "./cli-handoff";
import { SESSION_EXPIRES_IN_SECONDS } from "./session-config";

beforeEach(() => {
  mocks.deleteMany.mockReset();
  mocks.deleteMany.mockResolvedValue({ count: 3 });
});

describe("generateHandoffCode", () => {
  it("is trh_ plus 43 base64url characters", () => {
    expect(generateHandoffCode()).toMatch(/^trh_[A-Za-z0-9_-]{43}$/);
  });

  it("does not trip the CLI's API-key sniffer", () => {
    // looksLikeApiKey is /^tr[_-]/ — it needs `_` or `-` at index 2, and `trh_`
    // has `h` there, so a handoff code can never be read as a project key.
    expect(/^tr[_-]/.test(generateHandoffCode())).toBe(false);
  });

  it("never repeats", () => {
    const codes = new Set(Array.from({ length: 200 }, generateHandoffCode));
    expect(codes.size).toBe(200);
  });
});

describe("hashHandoffCode", () => {
  it("is SHA-256 hex of the code", () => {
    const code = generateHandoffCode();
    expect(hashHandoffCode(code)).toBe(createHash("sha256").update(code).digest("hex"));
    expect(hashHandoffCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable, so mint and redeem agree", () => {
    const code = generateHandoffCode();
    expect(hashHandoffCode(code)).toBe(hashHandoffCode(code));
    expect(hashHandoffCode(code)).not.toBe(hashHandoffCode(`${code}x`));
  });
});

describe("HANDOFF_TTL_SECONDS", () => {
  it("is ten minutes, not the device flow's thirty", () => {
    expect(HANDOFF_TTL_SECONDS).toBe(600);
  });
});

describe("pruneExpiredHandoffs", () => {
  it("deletes only rows expired longer ago than a session can live", async () => {
    const now = Date.parse("2026-10-16T12:00:00.000Z");
    const deleted = await pruneExpiredHandoffs(now);

    expect(deleted).toBe(3);
    const where = mocks.deleteMany.mock.calls[0][0].where;
    // A redeemed row must outlive the session it minted, so redeemedSessionId
    // stays answerable for as long as that session can be presented.
    expect(where.expiresAt.lt.getTime()).toBe(now - SESSION_EXPIRES_IN_SECONDS * 1000);
    // Scoped by expiry alone: a live or recently spent row is never touched.
    expect(Object.keys(where)).toEqual(["expiresAt"]);
  });

  it("leaves a row that expired a minute ago alone", async () => {
    const now = Date.now();
    await pruneExpiredHandoffs(now);
    const cutoff = mocks.deleteMany.mock.calls[0][0].where.expiresAt.lt.getTime();
    expect(cutoff).toBeLessThan(now - 60_000);
  });
});
