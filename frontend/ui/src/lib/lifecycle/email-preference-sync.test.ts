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
  emailProviderWriteVersion?: number | null;
  emailProviderRejectedVersion?: number | null;
};
const db = vi.hoisted(() => ({
  clock: 0,
  row: null as null | Row,
  pending: [] as { user_id: string; email: string }[],
  queries: [] as string[],
  // Runs once, just before the next lease is taken / the next write starts.
  hookBeforeLease: null as null | (() => void),
  hookBeforeWrite: null as null | (() => void),
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
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      db.queries.push(sql);
      const r = db.row;
      if (sql.includes("SET email_provider_lease_until")) {
        const hook = db.hookBeforeLease;
        db.hookBeforeLease = null;
        hook?.();
        if (!r || (r.emailProviderLeaseUntil && +r.emailProviderLeaseUntil > db.clock)) return [];
        r.emailProviderLeaseUntil = new Date((db.clock += 1) + 30_000);
        return [{ until: r.emailProviderLeaseUntil }];
      }
      if (sql.includes("SET email_provider_write_at")) {
        const hook = db.hookBeforeWrite;
        db.hookBeforeWrite = null;
        hook?.();
        if (!r) return [];
        // Only for the version the writer read (when the statement asks for it).
        if (sql.includes("email_preference_version =") && r.emailPreferenceVersion !== values[3])
          return [];
        if (r.emailProviderLeaseUntil === null) return [];
        r.emailProviderWriteAt = new Date((db.clock += 1));
        r.emailProviderWriteVersion = values[0] as number;
        r.emailProviderRejectedVersion = null; // the attempt supersedes an earlier refusal
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

import { ensureContact, setTopicSubscription } from "@traceroot/core/email";
import {
  LEASE_MS,
  HOLD_BUDGET_MS,
  setProviderTopic,
  syncEmailPreference,
  syncPendingEmailPreferences,
} from "./email-preference-sync";

const T1 = new Date("2026-12-01T10:00:00.001Z");
let provider: string | undefined;
const setTopic =
  vi.fn<
    (
      email: string,
      choice: string,
      deadline?: AbortSignal,
    ) => Promise<"ok" | "rejected" | "unknown">
  >();
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
  db.hookBeforeLease = null;
  db.hookBeforeWrite = null;
  setTopic.mockReset().mockImplementation(async (_e, choice) => ((provider = choice), "ok"));
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
      return "ok";
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      state: "applied",
      subscribed: false,
    });
    expect(provider).toBe("opt_out");
    expect(db.row!.emailProviderAckVersion).toBe(1);
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
    expect(db.row!.emailProviderSettledAt).toBeNull(); // the scheduled run confirms it
  });

  it.each([
    [
      "a newer unsubscribe, which it sends instead",
      true,
      ["opt_out"],
      { state: "applied", subscribed: false },
    ],
    [
      "a newer Subscribe again, which it leaves to its own request",
      false,
      [],
      { state: "superseded", subscribed: true },
    ],
  ] as const)(
    "never sends a choice that went stale before it took the lease: %s",
    async (_case, newerOptOut, sent, result) => {
      // Read as Subscribe again (v1); before the lease is taken a newer choice is
      // made and sent by its own request.
      db.row!.unsubscribedAt = null;
      db.hookBeforeLease = () => {
        choose(newerOptOut);
        db.row!.emailProviderAckVersion = db.row!.emailPreferenceVersion;
        provider = newerOptOut ? "opt_out" : "opt_in";
      };
      expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual(result);
      expect(setTopic.mock.calls.map((c) => c[1])).toEqual(sent);
      expect(provider).toBe(newerOptOut ? "opt_out" : "opt_in");
      expect(db.row!.emailProviderLeaseUntil).toBeNull();
    },
  );

  it("does not send a choice that went stale between the read under the lease and the write", async () => {
    db.row!.unsubscribedAt = null; // a Subscribe again
    db.hookBeforeWrite = () => choose(true); // an unsubscribe lands just before the send
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      state: "applied",
      subscribed: false,
    });
    expect(setTopic.mock.calls.map((c) => c[1])).toEqual(["opt_out"]);
  });

  it("acknowledges nothing, and leaves the new writer's lease alone, when its own lease ran out before the answer", async () => {
    let theirs: Date | undefined;
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      // The lease runs out mid-request and another writer takes it.
      theirs = new Date(db.clock + 99_999);
      db.row!.emailProviderLeaseUntil = theirs;
      return "ok";
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({ state: "unknown" });
    expect(db.row!.emailProviderAckVersion).toBeNull();
    expect(db.row!.emailProviderLeaseUntil).toEqual(theirs);
  });

  it("gives the provider a deadline well inside the lease", async () => {
    expect(HOLD_BUDGET_MS).toBeLessThanOrEqual(LEASE_MS / 2);
    const signals: (AbortSignal | undefined)[] = [];
    setTopic.mockImplementationOnce(async (_e, choice, deadline) => {
      signals.push(deadline);
      provider = choice;
      return "ok";
    });
    await syncEmailPreference("u1", "kai@acme.dev", setTopic);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("sends nothing while another write holds the lease, and marks the choice as racing it", async () => {
    db.row!.emailProviderLeaseUntil = new Date(db.clock + 10_000);
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({ state: "queued" });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderContendedVersion).toBe(1);
  });

  it("sends a newer opt-out made while its own write was on its way", async () => {
    db.row!.unsubscribedAt = null;
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      choose(true); // an unsubscribe while the Subscribe again is on its way
      return "ok";
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      state: "applied",
      subscribed: false,
    });
    expect(setTopic.mock.calls.map((c) => c[1])).toEqual(["opt_in", "opt_out"]);
    expect(db.row!.emailProviderAckVersion).toBe(2);
  });

  it("does not send a newer Subscribe again made while its own write was on its way", async () => {
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      choose(false); // a Subscribe again while the unsubscribe is on its way
      return "ok";
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      state: "applied",
      subscribed: false,
    });
    expect(setTopic).toHaveBeenCalledTimes(1);
    expect(provider).toBe("opt_out");
    expect(db.row!.emailProviderAckVersion).toBeNull();
  });

  it("records a refusal for the scheduled run to send again, and tells apart no answer", async () => {
    setTopic.mockResolvedValueOnce("rejected");
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      state: "rejected",
    });
    expect(db.row!.emailProviderRejectedVersion).toBe(1);
    expect(db.row!.emailProviderAckVersion).toBeNull();
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
    setTopic.mockResolvedValueOnce("unknown");
    db.row!.emailProviderRejectedVersion = null;
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({ state: "unknown" });
    expect(db.row!.emailProviderRejectedVersion).toBeNull();
    expect(db.row!.emailProviderWriteVersion).toBe(1);
  });
});

describe("syncPendingEmailPreferences, the scheduled run", () => {
  it("only confirms when the provider already holds the account's choice", async () => {
    provider = "opt_out";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
  });

  it.each([
    ["refused", { emailProviderWriteVersion: 1, emailProviderRejectedVersion: 1 }],
    ["never sent", {}],
  ])("sets a Subscribe again whose write was %s at the provider", async (_case, state) => {
    Object.assign(db.row!, { unsubscribedAt: null }, state);
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

  it("reads and writes the provider under the one budget taken with the lease", async () => {
    Object.assign(db.row!, { unsubscribedAt: null });
    provider = "opt_out";
    const signals: (AbortSignal | undefined)[] = [];
    readTopic.mockImplementationOnce((async (_e: string, deadline?: AbortSignal) => {
      signals.push(deadline);
      return "opt_out";
    }) as never);
    setTopic.mockImplementationOnce(async (_e, choice, deadline) => {
      signals.push(deadline);
      provider = choice;
      return "ok";
    });
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[1]).toBe(signals[0]);
  });

  it("sends nothing, and gives the lease back, when the reads used up the budget", async () => {
    Object.assign(db.row!, { unsubscribedAt: null });
    provider = "opt_out";
    readTopic.mockImplementationOnce((async () => {
      await new Promise((r) => setTimeout(r, 80));
      return "opt_out";
    }) as never);
    expect(
      await syncPendingEmailPreferences({
        setTopic,
        readTopic,
        settleAfterMs: 0,
        timing: { leaseMs: 60_000, holdBudgetMs: 40 },
      }),
    ).toEqual({ synced: 0, pending: 1, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.emailProviderWriteVersion ?? null).toBeNull();
    expect(db.row!.emailProviderLeaseUntil).toBeNull();
  });

  it("lets a new attempt supersede an earlier refusal, so its lost answer counts as unknown", async () => {
    Object.assign(db.row!, {
      unsubscribedAt: null,
      emailProviderWriteVersion: 1,
      emailProviderRejectedVersion: 1, // attempt 1 was refused
    });
    provider = "opt_out";
    setTopic.mockImplementationOnce(async (_e, choice) => ((provider = choice), "unknown"));
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
    expect(provider).toBe("opt_in"); // applied, answer lost
    expect(db.row!.emailProviderRejectedVersion).toBeNull();
    provider = "opt_out"; // withdrawn at the provider
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(setTopic).toHaveBeenCalledTimes(1);
    expect(db.row!.unsubscribedAt).not.toBeNull();
  });

  it("keeps the provider opt-out over a Subscribe again written with no answer (its writer died)", async () => {
    Object.assign(db.row!, { unsubscribedAt: null, emailProviderWriteVersion: 1 });
    provider = "opt_out";
    expect(await runOnce()).toEqual({ synced: 1, pending: 0, remaining: 0 });
    expect(setTopic).not.toHaveBeenCalled();
    expect(db.row!.unsubscribedAt).not.toBeNull();
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
    setTopic.mockImplementationOnce(async () => (choose(false), "ok"));
    expect(await runOnce()).toEqual({ synced: 0, pending: 1, remaining: 0 });
    expect(db.row!.emailProviderSettledAt).toBeNull();
  });

  it("counts a provider failure as pending, and keeps going", async () => {
    setTopic.mockResolvedValueOnce("rejected");
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
      "email_provider_write_at <= (clock_timestamp() AT TIME ZONE 'UTC') - ? * interval '1 millisecond'",
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

describe("setProviderTopic", () => {
  it("ends every provider request at the write's deadline, and counts that as no answer", async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response("{}");
    }) as typeof fetch;
    try {
      const deadline = new AbortController();
      vi.mocked(ensureContact).mockImplementationOnce(async (_input, options) => {
        await options!.fetchImpl!("https://api.resend.com/contacts/x", {});
        return { ok: true };
      });
      vi.mocked(setTopicSubscription).mockImplementationOnce(async (_e, _c, options) => {
        deadline.abort();
        await options!.fetchImpl!("https://api.resend.com/contacts/x/topics", {});
        return { ok: false }; // the ended request: no answer
      });
      expect(await setProviderTopic("kai@acme.dev", "opt_in", deadline.signal)).toBe("unknown");
      expect(seen).toHaveLength(2);
      expect(seen.every((signal) => signal === deadline.signal)).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("tells a refusal from no answer", async () => {
    vi.mocked(ensureContact).mockResolvedValue({ ok: true });
    vi.mocked(setTopicSubscription).mockResolvedValueOnce({ ok: false, rejected: true });
    expect(await setProviderTopic("kai@acme.dev", "opt_in")).toBe("rejected");
    vi.mocked(setTopicSubscription).mockResolvedValueOnce({ ok: false });
    expect(await setProviderTopic("kai@acme.dev", "opt_in")).toBe("unknown");
    vi.mocked(ensureContact).mockResolvedValueOnce({ ok: false });
    expect(await setProviderTopic("kai@acme.dev", "opt_in")).toBe("rejected");
  });
});
