import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { reserveAgentIdOwnerSlot } from "./agentid-owner-cap";

// Runs against a scratch database migrated with `prisma migrate deploy`; it
// empties users and owner links, so never point it at a shared database.
const url = process.env.AGENTID_CAP_TEST_DATABASE_URL;

describe.skipIf(!url)("reserveAgentIdOwnerSlot against Postgres", () => {
  const prisma = new PrismaClient({ datasourceUrl: url });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "users", "agentid_owner_links" CASCADE`);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admits exactly `max` of many simultaneous sign-ups for one owner", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        reserveAgentIdOwnerSlot(prisma, "owner-a", `agent-${i}`, 3),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await prisma.agentIdOwnerLink.count({ where: { ownerSub: "owner-a" } })).toBe(3);
  });

  it("lets the same agent retry without counting itself twice", async () => {
    expect(await reserveAgentIdOwnerSlot(prisma, "owner-a", "agent-1", 1)).toBe(true);
    expect(await reserveAgentIdOwnerSlot(prisma, "owner-a", "agent-1", 1)).toBe(true);
    expect(await reserveAgentIdOwnerSlot(prisma, "owner-a", "agent-2", 1)).toBe(false);
  });

  it("stops counting a stale link with no account, keeps counting one with an account", async () => {
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await prisma.agentIdOwnerLink.createMany({
      data: [
        { agentSub: "stale-orphan", ownerSub: "owner-a", createdAt: anHourAgo },
        { agentSub: "stale-live", ownerSub: "owner-a", createdAt: anHourAgo },
      ],
    });
    await prisma.user.create({
      data: {
        email: "live@agentmail.to",
        accounts: { create: { accountId: "stale-live", providerId: "agentid" } },
      },
    });

    expect(await reserveAgentIdOwnerSlot(prisma, "owner-a", "agent-new", 2)).toBe(true);
    expect(await reserveAgentIdOwnerSlot(prisma, "owner-a", "agent-newer", 2)).toBe(false);
  });
});
