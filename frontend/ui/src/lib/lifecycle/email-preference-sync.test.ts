import { beforeEach, describe, expect, it, vi } from "vitest";

// One onboarding row and the calls the sync makes on it; `clock` stands in for
// the database's clock_timestamp().
type Row = {
  userId: string;
  unsubscribedAt: Date | null;
  emailPreferenceAt: Date | null;
  emailPreferenceVersion: number;
  emailProviderWriteAt: Date | null;
  emailProviderSettledAt: Date | null;
  emailProviderAckVersion: number | null;
  emailProviderCheckedAt?: Date | null;
};
const db = vi.hoisted(() => ({
  clock: 0,
  row: null as null | Row,
  pending: [] as { user_id: string; email: string }[],
  queries: [] as string[],
}));
const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? +a === +b : a === b;
vi.mock("@traceroot/core", () => ({
  prisma: {
    userOnboarding: {
      findUnique: async () => (db.row ? { ...db.row } : null),
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<Row>;
      }) => {
        const r = db.row;
        if (!r) return { count: 0 };
        const { userId: _u, ...conds } = where;
        if (!Object.entries(conds).every(([k, v]) => same(r[k as keyof Row], v)))
          return { count: 0 };
        Object.assign(r, data);
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
    // The provider-side opt-out recorded by the scheduled run.
    $executeRaw: async (_s: TemplateStringsArray, userId: string, version: number) => {
      const r = db.row;
      if (!r || r.userId !== userId || r.emailPreferenceVersion !== version) return 0;
      r.unsubscribedAt ??= new Date(db.clock);
      r.emailPreferenceVersion += 1;
      r.emailProviderAckVersion = r.emailPreferenceVersion;
      r.emailProviderSettledAt = r.emailProviderWriteAt ?? new Date(0);
      return 1;
    },
  },
}));
vi.mock("@traceroot/core/email", () => ({
  ensureContact: vi.fn(),
  setTopicSubscription: vi.fn(),
  providerState: vi.fn(),
  resendConfig: vi.fn(() => ({})),
}));

import { syncEmailPreference, syncPendingEmailPreferences } from "./email-preference-sync";

const T1 = new Date("2026-12-01T10:00:00.001Z");
let provider: string | undefined;
const setTopic = vi.fn<(email: string, choice: string) => Promise<boolean>>();
const readTopic = vi.fn(async () => (provider ?? "missing") as "opt_in" | "opt_out" | "missing");
const choose = (unsubscribed: boolean) => {
  db.row!.unsubscribedAt = unsubscribed ? T1 : null;
  db.row!.emailPreferenceVersion += 1; // what recordUnsubscribe does, same time or not
  db.row!.emailProviderSettledAt = null;
};
const runOnce = (o: { limit?: number; budgetMs?: number } = {}) =>
  syncPendingEmailPreferences({ setTopic, readTopic, settleAfterMs: 0, ...o });

beforeEach(() => {
  provider = undefined;
  db.clock = 1_000;
  db.queries = [];
  setTopic.mockReset().mockImplementation(async (_e, choice) => ((provider = choice), true));
  readTopic.mockClear();
  db.row = {
    userId: "u1",
    unsubscribedAt: T1,
    emailPreferenceAt: T1,
    emailPreferenceVersion: 1,
    emailProviderWriteAt: null,
    emailProviderSettledAt: null,
    emailProviderAckVersion: null,
  };
  db.pending = [{ user_id: "u1", email: "kai@acme.dev" }];
});

describe("syncEmailPreference, on the unsubscribe page", () => {
  it("records the write before sending it, sets the provider and records the acknowledgement", async () => {
    setTopic.mockImplementationOnce(async (_e, choice) => {
      expect(db.row!.emailProviderWriteAt).not.toBeNull();
      provider = choice;
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      subscribed: false,
    });
    expect(provider).toBe("opt_out");
    expect(db.row!.emailProviderAckVersion).toBe(1);
    expect(db.row!.emailProviderSettledAt).toBeNull(); // the scheduled run confirms it
  });

  it("follows a choice made in the same millisecond, and drops the stale acknowledgement", async () => {
    db.row!.unsubscribedAt = null;
    db.row!.emailProviderAckVersion = 1;
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      choose(true); // an unsubscribe at the same instant
      return true;
    });
    let ackSeen: number | null | undefined;
    setTopic.mockImplementationOnce(async (_e, choice) => {
      ackSeen = db.row!.emailProviderAckVersion;
      provider = choice;
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      subscribed: false,
    });
    expect(setTopic.mock.calls.map((c) => c[1])).toEqual(["opt_in", "opt_out"]);
    expect(ackSeen).toBeNull(); // cleared once the opt-in was found stale
    expect(db.row!.emailProviderAckVersion).toBe(2);
  });

  it("gives up after three rounds of choices changing underneath it", async () => {
    setTopic.mockImplementation(async () => (choose(false), true));
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(setTopic).toHaveBeenCalledTimes(3);
  });

  it("answers null when the provider fails, leaving it unacknowledged for the scheduled run", async () => {
    setTopic.mockResolvedValueOnce(false);
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(db.row!.emailProviderAckVersion).toBeNull();
  });
});

describe("syncPendingEmailPreferences, the scheduled run", () => {
  it("only confirms when the provider already holds the account's choice", async () => {
    provider = "opt_out";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderSettledAt).not.toBeNull();
  });

  it("sets an unacknowledged choice at the provider: a failed or pending request is recovered", async () => {
    db.row!.unsubscribedAt = null; // a Subscribe again whose write failed
    provider = "opt_out";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(provider).toBe("opt_in");
    expect(db.row!.emailProviderAckVersion).toBe(1);
  });

  it("keeps an opt-out made at the provider after it acknowledged a Subscribe again", async () => {
    db.row!.unsubscribedAt = null;
    db.row!.emailProviderAckVersion = 1;
    provider = "opt_out"; // changed at the provider
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.unsubscribedAt).not.toBeNull();
    expect(db.row!.emailPreferenceVersion).toBe(2);
  });

  it("sets an acknowledged opt-out back when the provider shows opt-in", async () => {
    db.row!.emailProviderAckVersion = 1;
    provider = "opt_in";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(provider).toBe("opt_out");
  });

  it("leaves it for later, looked at but not acknowledged or settled, when the provider cannot be read", async () => {
    readTopic.mockResolvedValueOnce(null as never);
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderCheckedAt).toBeInstanceOf(Date);
    expect(db.row!.emailProviderAckVersion).toBeNull();
    expect(db.row!.emailProviderSettledAt).toBeNull();
  });

  it("does not mark it settled when a choice came along meanwhile", async () => {
    setTopic.mockImplementationOnce(async () => (choose(false), true));
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
    expect(db.row!.emailProviderSettledAt).toBeNull();
  });

  it("counts a provider failure as pending, and keeps going", async () => {
    setTopic.mockResolvedValueOnce(false);
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
    setTopic.mockRejectedValueOnce(new Error("network"));
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
  });

  it("asks for the least recently written first, after the settle window, in bounded batches", async () => {
    await syncPendingEmailPreferences({ setTopic, readTopic, limit: 7, settleAfterMs: 1234 });
    const select = db.queries.find((q) => q.includes("SELECT"))!;
    expect(select).toContain(
      "ORDER BY o.email_provider_checked_at NULLS FIRST, o.email_provider_write_at",
    );
    expect(select).toContain(
      "email_provider_write_at <= clock_timestamp() - ? * interval '1 millisecond'",
    );
    expect(select).toContain("LIMIT ?");
  });

  it("stops starting new people after its time budget, and counts the rest as remaining", async () => {
    db.pending = [1, 2, 3].map(() => ({ user_id: "u1", email: "kai@acme.dev" }));
    readTopic.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return "missing";
    });
    const result = await runOnce({ budgetMs: 10 });
    expect(result.remaining).toBeGreaterThan(0);
    expect(result.synced + result.pending + result.remaining).toBe(3);
  });
});
