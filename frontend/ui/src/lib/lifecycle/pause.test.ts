import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory users and onboarding rows, with the calls this module makes and the
// conditions they use (equality, null, `not: null`, `lt`, OR).
type Row = {
  userId: string;
  followUpsPausedAt: Date | null;
  followUpsPauseReason: string | null;
  followUpsIntentAt: Date | null;
  unsubscribedAt: Date | null;
  emailPreferenceAt: Date | null;
};
const db = vi.hoisted(() => ({
  users: [] as { id: string; email: string }[],
  rows: [] as Row[],
}));
vi.mock("@traceroot/core", () => {
  const row = (userId: string) => db.rows.find((r) => r.userId === userId);
  type Cond = Record<string, unknown>;
  const test = (value: unknown, cond: unknown): boolean => {
    if (cond === null) return value === null;
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; lt?: Date };
      if ("not" in c) return c.not === null ? value !== null : value !== c.not;
      if ("lt" in c) return value instanceof Date && value < c.lt!;
    }
    return value instanceof Date && cond instanceof Date ? +value === +cond : value === cond;
  };
  const matches = (r: Row, where: Cond): boolean =>
    Object.entries(where).every(([k, v]) =>
      k === "OR"
        ? (v as Cond[]).some((alt) => matches(r, alt))
        : test((r as unknown as Cond)[k], v),
    );
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
                followUpsIntentAt: null,
                unsubscribedAt: null,
                emailPreferenceAt: null,
              });
          return { count: 1 };
        },
        updateMany: async ({ where, data }: { where: Cond; data: Partial<Row> }) => {
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

const T1 = new Date("2026-12-01T10:00:00.001Z");
const T2 = new Date("2026-12-01T10:00:00.002Z");
const T3 = new Date("2026-12-01T10:00:05.000Z");

beforeEach(() => {
  db.users = [{ id: "u1", email: "Kai@Acme.dev" }];
  db.rows = [];
});

describe("pausing and resuming", () => {
  it("pauses with a reason, and answers that it applied", async () => {
    expect(await setFollowUpPause("u1", "pause", T1, "conversation")).toEqual({
      paused: true,
      pauseReason: "conversation",
      unsubscribed: false,
      intentAt: T1,
      applied: true,
    });
  });

  it("keeps the first pause's time and reason when a newer pause finds it paused", async () => {
    await setFollowUpPause("u1", "pause", T1, "conversation", T1);
    const second = await setFollowUpPause("u1", "pause", T2, "outreach", T2);
    expect(second).toMatchObject({ applied: true, pauseReason: "conversation", intentAt: T2 });
    expect(db.rows[0].followUpsPausedAt).toEqual(T1);
  });

  it("resumes on a newer decision", async () => {
    await setFollowUpPause("u1", "pause", T1, "manual");
    expect(await setFollowUpPause("u1", "resume", T2)).toEqual({
      paused: false,
      pauseReason: null,
      unsubscribed: false,
      intentAt: T2,
      applied: true,
    });
  });

  it("answers null for an unknown user, writing nothing", async () => {
    expect(await setFollowUpPause("nobody", "pause", T1)).toBeNull();
    expect(db.rows).toHaveLength(0);
  });
});

describe("out of order and repeated calls", () => {
  it("ignores an old pause that lands after a newer resume", async () => {
    // Paused at T1, resumed at T2; the T1 pause, retried or committed late, lands last.
    await setFollowUpPause("u1", "pause", T1, "manual");
    await setFollowUpPause("u1", "resume", T2);
    const late = await setFollowUpPause("u1", "pause", T1, "manual");
    expect(late).toMatchObject({ applied: false, paused: false, intentAt: T2 });
    expect(db.rows[0]).toMatchObject({ followUpsPausedAt: null, followUpsIntentAt: T2 });
  });

  it("ignores an old resume that lands after a newer pause", async () => {
    await setFollowUpPause("u1", "pause", T2, "conversation");
    const late = await setFollowUpPause("u1", "resume", T1);
    expect(late).toMatchObject({ applied: false, paused: true, pauseReason: "conversation" });
  });

  it("treats the same decision delivered twice as one", async () => {
    await setFollowUpPause("u1", "pause", T1, "manual");
    await setFollowUpPause("u1", "resume", T2);
    const again = await setFollowUpPause("u1", "resume", T2);
    expect(again).toMatchObject({ applied: false, paused: false, intentAt: T2 });
  });

  it("applies the first decision for someone with none yet", async () => {
    expect(await setFollowUpPause("u1", "resume", T1)).toMatchObject({
      applied: true,
      intentAt: T1,
    });
  });
});

describe("unsubscribe stays in force", () => {
  it("through a resume, an old pause landing late, and a newer pause", async () => {
    await recordUnsubscribe("kai@acme.dev", false, T1);
    await setFollowUpPause("u1", "pause", T1, "outreach");
    expect((await setFollowUpPause("u1", "resume", T2))?.unsubscribed).toBe(true);
    expect((await setFollowUpPause("u1", "pause", T1, "outreach"))?.unsubscribed).toBe(true);
    expect((await setFollowUpPause("u1", "pause", T3, "manual"))?.unsubscribed).toBe(true);
    expect(db.rows[0].unsubscribedAt).toEqual(T1);
  });
});

describe("recording an unsubscribe", () => {
  it("finds the account by address, whatever its case", async () => {
    expect(await recordUnsubscribe(" KAI@acme.DEV ", false, T1)).toEqual({
      userId: "u1",
      applied: true,
      subscribed: false,
    });
    expect(db.rows[0].unsubscribedAt).toEqual(T1);
  });

  it("clears it on Subscribe again, leaving a pause in place", async () => {
    await setFollowUpPause("u1", "pause", T1, "outreach");
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

describe("the latest unsubscribe or Subscribe again wins", () => {
  it("ignores a Subscribe again made before a newer unsubscribe, however late it lands", async () => {
    await recordUnsubscribe("kai@acme.dev", false, T2);
    expect(await recordUnsubscribe("kai@acme.dev", true, T1)).toEqual({
      userId: "u1",
      applied: false,
      subscribed: false,
    });
    expect(db.rows[0]).toMatchObject({ unsubscribedAt: T2, emailPreferenceAt: T2 });
  });

  it("still lets a later, deliberate Subscribe again through", async () => {
    await recordUnsubscribe("kai@acme.dev", false, T1);
    expect(await recordUnsubscribe("kai@acme.dev", true, T2)).toMatchObject({
      applied: true,
      subscribed: true,
    });
    expect(db.rows[0]).toMatchObject({ unsubscribedAt: null, emailPreferenceAt: T2 });
  });

  it("ignores an unsubscribe made before a newer Subscribe again", async () => {
    await recordUnsubscribe("kai@acme.dev", true, T2);
    expect(await recordUnsubscribe("kai@acme.dev", false, T1)).toMatchObject({
      applied: false,
      subscribed: true,
    });
    expect(db.rows[0].unsubscribedAt).toBeNull();
  });

  it("applies a choice on an account recorded before choices had a time", async () => {
    await recordUnsubscribe("kai@acme.dev", false, T1);
    db.rows[0].emailPreferenceAt = null;
    expect(await recordUnsubscribe("kai@acme.dev", true, T2)).toMatchObject({ applied: true });
  });
});
