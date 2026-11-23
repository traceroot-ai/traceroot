import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory users and onboarding rows, with the calls this module makes.
type Row = {
  userId: string;
  followUpsPausedAt: Date | null;
  followUpsPauseReason: string | null;
  unsubscribedAt: Date | null;
};
const db = vi.hoisted(() => ({
  users: [] as { id: string; email: string }[],
  rows: [] as Row[],
}));
vi.mock("@traceroot/core", () => {
  const row = (userId: string) => db.rows.find((r) => r.userId === userId);
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v);
  return {
    prisma: {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          db.users.find((u) => u.id === where.id) ?? null,
        findFirst: async ({ where }: { where: { email: { equals: string } } }) =>
          db.users.find((u) => u.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null,
      },
      userOnboarding: {
        createMany: async ({ data }: { data: { userId: string }[] }) => {
          for (const { userId } of data)
            if (!row(userId))
              db.rows.push({
                userId,
                followUpsPausedAt: null,
                followUpsPauseReason: null,
                unsubscribedAt: null,
              });
          return { count: 1 };
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: Record<string, unknown>;
          data: Partial<Row>;
        }) => {
          const hits = db.rows.filter((r) => matches(r, where));
          for (const r of hits) Object.assign(r, data);
          return { count: hits.length };
        },
        findUnique: async ({ where }: { where: { userId: string } }) => row(where.userId) ?? null,
      },
    },
  };
});

import { recordUnsubscribe, setFollowUpPause } from "./pause";

const T1 = new Date("2026-12-01T10:00:00Z");
const T2 = new Date("2026-12-02T10:00:00Z");

beforeEach(() => {
  db.users = [{ id: "u1", email: "Kai@Acme.dev" }];
  db.rows = [];
});

describe("pausing and resuming", () => {
  it("pauses with a reason, and a second pause keeps the first", async () => {
    expect(await setFollowUpPause("u1", "pause", "conversation", T1)).toEqual({
      paused: true,
      pauseReason: "conversation",
      unsubscribed: false,
    });
    await setFollowUpPause("u1", "pause", "outreach", T2);
    expect(db.rows[0]).toMatchObject({
      followUpsPausedAt: T1,
      followUpsPauseReason: "conversation",
    });
  });

  it("resumes, and resuming twice changes nothing", async () => {
    await setFollowUpPause("u1", "pause", "manual", T1);
    const once = await setFollowUpPause("u1", "resume");
    expect(await setFollowUpPause("u1", "resume")).toEqual(once);
    expect(once).toEqual({ paused: false, pauseReason: null, unsubscribed: false });
  });

  it("does not undo an unsubscribe on resume", async () => {
    await recordUnsubscribe("kai@acme.dev", false, T1);
    await setFollowUpPause("u1", "pause", "outreach", T1);
    expect(await setFollowUpPause("u1", "resume")).toEqual({
      paused: false,
      pauseReason: null,
      unsubscribed: true,
    });
  });

  it("answers null for an unknown user, writing nothing", async () => {
    expect(await setFollowUpPause("nobody", "pause")).toBeNull();
    expect(db.rows).toHaveLength(0);
  });
});

describe("recording an unsubscribe", () => {
  it("finds the account by address, whatever its case", async () => {
    expect(await recordUnsubscribe(" KAI@acme.DEV ", false, T1)).toBe("u1");
    expect(db.rows[0].unsubscribedAt).toEqual(T1);
  });

  it("clears it on Subscribe again, leaving a pause in place", async () => {
    await setFollowUpPause("u1", "pause", "outreach", T1);
    await recordUnsubscribe("kai@acme.dev", false, T1);
    await recordUnsubscribe("kai@acme.dev", true, T2);
    expect(db.rows[0]).toMatchObject({ unsubscribedAt: null, followUpsPauseReason: "outreach" });
  });

  it("keeps the first time when the link is used twice", async () => {
    await recordUnsubscribe("kai@acme.dev", false, T1);
    await recordUnsubscribe("kai@acme.dev", false, T2);
    expect(db.rows[0].unsubscribedAt).toEqual(T1);
  });

  it("records nothing for an address with no account", async () => {
    expect(await recordUnsubscribe("someone@else.dev", false)).toBeNull();
    expect(db.rows).toHaveLength(0);
  });
});
