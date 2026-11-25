import { beforeEach, describe, expect, it, vi } from "vitest";

// One onboarding row and the calls the sync makes on it; `clock` stands in for
// the database's clock_timestamp().
const db = vi.hoisted(() => ({
  clock: 0,
  row: null as null | {
    userId: string;
    unsubscribedAt: Date | null;
    emailPreferenceAt: Date | null;
    emailPreferenceVersion: number;
    emailProviderWriteAt: Date | null;
    emailProviderSettledAt: Date | null;
  },
  pending: [] as { user_id: string; email: string }[],
  queries: [] as string[],
}));
vi.mock("@traceroot/core", () => ({
  prisma: {
    userOnboarding: {
      findUnique: async () => (db.row ? { ...db.row } : null),
      updateMany: async ({
        where,
        data,
      }: {
        where: { emailPreferenceVersion: number; emailProviderWriteAt: Date };
        data: { emailProviderSettledAt: Date };
      }) => {
        const r = db.row;
        if (
          !r ||
          r.emailPreferenceVersion !== where.emailPreferenceVersion ||
          +r.emailProviderWriteAt! !== +where.emailProviderWriteAt
        )
          return { count: 0 };
        r.emailProviderSettledAt = data.emailProviderSettledAt;
        return { count: 1 };
      },
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      db.queries.push(sql);
      if (sql.includes("UPDATE user_onboarding")) {
        if (!db.row) return [];
        db.row.emailProviderWriteAt = new Date((db.clock += 1));
        return [{ at: db.row.emailProviderWriteAt }];
      }
      return db.pending;
    },
  },
}));
vi.mock("@traceroot/core/email", () => ({ ensureContact: vi.fn(), setTopicSubscription: vi.fn() }));

import { syncEmailPreference, syncPendingEmailPreferences } from "./email-preference-sync";

const T1 = new Date("2026-12-01T10:00:00.001Z");
let provider: string | undefined;
const setTopic = vi.fn<(email: string, choice: string) => Promise<boolean>>();
const choose = (unsubscribed: boolean) => {
  db.row!.unsubscribedAt = unsubscribed ? T1 : null;
  db.row!.emailPreferenceVersion += 1; // what recordUnsubscribe does, same time or not
  db.row!.emailProviderSettledAt = null;
};

beforeEach(() => {
  provider = undefined;
  db.clock = 1_000;
  db.queries = [];
  setTopic.mockReset().mockImplementation(async (_e, choice) => ((provider = choice), true));
  db.row = {
    userId: "u1",
    unsubscribedAt: T1,
    emailPreferenceAt: T1,
    emailPreferenceVersion: 1,
    emailProviderWriteAt: null,
    emailProviderSettledAt: null,
  };
  db.pending = [{ user_id: "u1", email: "kai@acme.dev" }];
});

describe("syncEmailPreference, on the unsubscribe page", () => {
  it("records the write before sending it, then sets the provider to the account's choice", async () => {
    setTopic.mockImplementationOnce(async (_e, choice) => {
      expect(db.row!.emailProviderWriteAt).not.toBeNull();
      provider = choice;
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      subscribed: false,
    });
    expect(provider).toBe("opt_out");
    expect(db.row!.emailProviderSettledAt).toBeNull(); // the scheduled run confirms it
  });

  it("follows a choice made in the same millisecond, told apart by its version", async () => {
    db.row!.unsubscribedAt = null;
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      choose(true); // an unsubscribe at the same instant
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      subscribed: false,
    });
    expect(setTopic.mock.calls.map((c) => c[1])).toEqual(["opt_in", "opt_out"]);
  });

  it("gives up after three rounds of choices changing underneath it", async () => {
    setTopic.mockImplementation(async () => (choose(false), true));
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(setTopic).toHaveBeenCalledTimes(3);
  });

  it("answers null when the provider fails, leaving it to the scheduled run", async () => {
    setTopic.mockResolvedValueOnce(false);
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
  });
});

describe("syncPendingEmailPreferences, the scheduled run", () => {
  it("confirms the provider and marks the latest write settled", async () => {
    expect(await syncPendingEmailPreferences({ setTopic })).toEqual({ synced: 1, pending: 0 });
    expect(provider).toBe("opt_out");
    expect(db.row!.emailProviderSettledAt).toEqual(db.row!.emailProviderWriteAt);
  });

  it("does not mark it settled when a choice or another write came along meanwhile", async () => {
    setTopic.mockImplementationOnce(async () => (choose(false), true));
    expect(await syncPendingEmailPreferences({ setTopic })).toEqual({ synced: 0, pending: 1 });
    expect(db.row!.emailProviderSettledAt).toBeNull();
    setTopic.mockImplementationOnce(async () => {
      db.row!.emailProviderWriteAt = new Date((db.clock += 1)); // a request's write started
      return true;
    });
    expect(await syncPendingEmailPreferences({ setTopic })).toEqual({ synced: 0, pending: 1 });
  });

  it("counts a provider failure as pending, and keeps going", async () => {
    setTopic.mockResolvedValueOnce(false);
    expect(await syncPendingEmailPreferences({ setTopic })).toEqual({ synced: 0, pending: 1 });
    setTopic.mockRejectedValueOnce(new Error("network"));
    expect(await syncPendingEmailPreferences({ setTopic })).toEqual({ synced: 0, pending: 1 });
  });

  it("asks for the least recently written first, after the settle window, in bounded batches", async () => {
    await syncPendingEmailPreferences({ setTopic, limit: 7, settleAfterMs: 1234 });
    const select = db.queries.find((q) => q.includes("SELECT"))!;
    expect(select).toContain("ORDER BY o.email_provider_write_at NULLS FIRST");
    expect(select).toContain(
      "email_provider_write_at <= clock_timestamp() - ? * interval '1 millisecond'",
    );
    expect(select).toContain("LIMIT ?");
  });
});
