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
  emailProviderLeaseUntil: Date | null;
  emailProviderContendedVersion: number | null;
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
      const r = db.row;
      if (sql.includes("SET email_provider_lease_until")) {
        if (!r || (r.emailProviderLeaseUntil && +r.emailProviderLeaseUntil > db.clock)) return [];
        r.emailProviderLeaseUntil = new Date((db.clock += 1) + 30_000);
        return [{ until: r.emailProviderLeaseUntil }];
      }
      if (sql.includes("SET email_provider_write_at")) {
        if (!r) return [];
        r.emailProviderWriteAt = new Date((db.clock += 1));
        return [{ at: r.emailProviderWriteAt }];
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
    emailProviderLeaseUntil: null,
    emailProviderContendedVersion: null,
  };
  db.pending = [{ user_id: "u1", email: "kai@acme.dev" }];
});

describe("syncEmailPreference, on the unsubscribe page", () => {
  it("takes the lease, records the write before sending it, and gives the lease back acknowledged", async () => {
    setTopic.mockImplementationOnce(async (_e, choice) => {
      expect(db.row!.emailProviderLeaseUntil).not.toBeNull();
      expect(db.row!.emailProviderWriteAt).not.toBeNull();
      provider = choice;
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      subscribed: false,
    });
    expect(provider).toBe("opt_out");
    expect(db.row!.emailProviderAckVersion).toBe(1);
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
    expect(db.row!.emailProviderSettledAt).toBeNull(); // the scheduled run confirms it
  });

  it("sends nothing while another write holds the lease, and marks the choice as racing it", async () => {
    db.row!.emailProviderLeaseUntil = new Date(db.clock + 10_000);
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderContendedVersion).toBe(1);
  });

  it("sends a newer opt-out made while its own write was on its way", async () => {
    db.row!.unsubscribedAt = null;
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      choose(true); // an unsubscribe while the Subscribe again is on its way
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      subscribed: false,
    });
    expect(setTopic.mock.calls.map((c) => c[1])).toEqual(["opt_in", "opt_out"]);
    expect(db.row!.emailProviderAckVersion).toBe(2);
  });

  it("does not send a newer Subscribe again made while its own write was on its way", async () => {
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      choose(false); // a Subscribe again while the unsubscribe is on its way
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(setTopic).toHaveBeenCalledTimes(1);
    expect(provider).toBe("opt_out");
    expect(db.row!.emailProviderAckVersion).toBeNull();
  });

  it("answers null when the provider fails, leaving it unacknowledged for the scheduled run", async () => {
    setTopic.mockResolvedValueOnce(false);
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(db.row!.emailProviderAckVersion).toBeNull();
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
  });
});

describe("syncPendingEmailPreferences, the scheduled run", () => {
  it("only confirms when the provider already holds the account's choice", async () => {
    provider = "opt_out";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
  });

  it("sets an uncontended, unacknowledged choice at the provider: a failed request is recovered", async () => {
    db.row!.unsubscribedAt = null; // a Subscribe again whose write failed
    provider = "opt_out";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(provider).toBe("opt_in");
    expect(db.row!.emailProviderAckVersion).toBe(1);
  });

  it.each([
    ["acknowledged, then changed at the provider", { emailProviderAckVersion: 1 }],
    ["made while another write was on its way", { emailProviderContendedVersion: 1 }],
  ])("keeps the provider opt-out over a Subscribe again %s", async (_case, state) => {
    Object.assign(db.row!, { unsubscribedAt: null }, state);
    provider = "opt_out";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.unsubscribedAt).not.toBeNull();
    expect(db.row!.emailPreferenceVersion).toBe(2);
  });

  it("sets an opt-out back when the provider shows opt-in", async () => {
    db.row!.emailProviderContendedVersion = 1;
    provider = "opt_in";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(provider).toBe("opt_out");
  });

  it("waits while another write holds the lease", async () => {
    db.row!.emailProviderLeaseUntil = new Date(db.clock + 10_000);
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
    expect(readTopic).not.toHaveBeenCalled();
  });

  it("leaves it for later, looked at but not acknowledged or settled, when the provider cannot be read", async () => {
    readTopic.mockResolvedValueOnce(null as never);
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderCheckedAt).toBeInstanceOf(Date);
    expect(db.row!.emailProviderAckVersion).toBeNull();
    expect(db.row!.emailProviderSettledAt).toBeNull();
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
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

  it("asks for the least recently looked at first, after the settle window, in bounded batches", async () => {
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
