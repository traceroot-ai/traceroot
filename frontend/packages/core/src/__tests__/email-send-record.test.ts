import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as record from "../lib/email/send-record.ts";

const [create, findUnique, updateMany, deleteMany] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
const db = {
  emailSend: { create, findUnique, updateMany, deleteMany },
} as unknown as record.EmailSendClient;
const params = { userId: "u1", campaign: "welcome", kind: "product" };
const now = new Date("2026-10-06T12:00:00Z");
const sentAt = new Date("2026-10-01T00:00:00Z");
const claimed = { status: "claimed", id: "send-1" };
const claim = () => record.claimEmailSend(db, { ...params, now });
const dup = new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "5" });

function lostRaceTo(row: { sentAt: Date | null }) {
  create.mockRejectedValue(dup);
  findUnique.mockResolvedValue({ id: "send-1", ...row });
}

beforeEach(() => vi.resetAllMocks());

describe("claimEmailSend", () => {
  it("claims a fresh (user, campaign) by inserting with claimedAt", async () => {
    create.mockResolvedValue({ id: "send-1" });
    expect(await claim()).toEqual(claimed);
    expect(create).toHaveBeenCalledWith({
      data: { ...params, claimedAt: now },
      select: { id: true },
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each([
    [{ sentAt }, { status: "already-sent", id: "send-1", sentAt }],
    [{ sentAt: null }, { status: "in-flight" }],
  ])("after losing the race to %o reports %o and never takes the row over", async (row, result) => {
    lostRaceTo(row);
    expect(await claim()).toEqual(result);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("stampEmailSend / releaseEmailSend", () => {
  it("touch only the unstamped row; false once it is stamped", async () => {
    const where = { id: "send-1", sentAt: null };
    updateMany.mockResolvedValue({ count: 1 });
    deleteMany.mockResolvedValue({ count: 1 });
    expect(await record.stampEmailSend(db, "send-1", "p1", now)).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({ where, data: { sentAt: now, providerId: "p1" } });
    expect(await record.releaseEmailSend(db, "send-1")).toBe(true);
    expect(deleteMany).toHaveBeenCalledWith({ where });
    updateMany.mockResolvedValue({ count: 0 });
    deleteMany.mockResolvedValue({ count: 0 });
    expect(await record.stampEmailSend(db, "send-1", null, now)).toBe(false);
    expect(await record.releaseEmailSend(db, "send-1")).toBe(false);
  });
});
