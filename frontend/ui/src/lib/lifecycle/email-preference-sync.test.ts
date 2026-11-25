import { beforeEach, describe, expect, it, vi } from "vitest";

// One onboarding row and the two calls the sync makes on it. `onSet` lets a test
// change the account while the provider is being set, as another request would.
const db = vi.hoisted(() => ({
  row: null as null | {
    userId: string;
    unsubscribedAt: Date | null;
    emailPreferenceAt: Date | null;
    emailPreferenceSyncedAt: Date | null;
  },
  pending: [] as { user_id: string; email: string }[],
}));
vi.mock("@traceroot/core", () => ({
  prisma: {
    userOnboarding: {
      findUnique: async () => (db.row ? { ...db.row } : null),
      updateMany: async ({
        where,
        data,
      }: {
        where: { emailPreferenceAt: Date };
        data: { emailPreferenceSyncedAt: Date };
      }) => {
        if (!db.row || +db.row.emailPreferenceAt! !== +where.emailPreferenceAt) return { count: 0 };
        db.row.emailPreferenceSyncedAt = data.emailPreferenceSyncedAt;
        return { count: 1 };
      },
    },
    $queryRaw: async () => db.pending,
  },
}));
vi.mock("@traceroot/core/email", () => ({ ensureContact: vi.fn(), setTopicSubscription: vi.fn() }));

import { syncEmailPreference, syncPendingEmailPreferences } from "./email-preference-sync";

const T1 = new Date("2026-12-01T10:00:00.001Z");
const T2 = new Date("2026-12-01T10:00:00.002Z");
let provider: string | undefined;
const setTopic = vi.fn<(email: string, choice: string) => Promise<boolean>>();

beforeEach(() => {
  provider = undefined;
  setTopic.mockReset().mockImplementation(async (_email, choice) => ((provider = choice), true));
  db.row = {
    userId: "u1",
    unsubscribedAt: T1,
    emailPreferenceAt: T1,
    emailPreferenceSyncedAt: null,
  };
  db.pending = [];
});

describe("syncEmailPreference", () => {
  it("sets the provider to the account's choice and marks it synced", async () => {
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({
      subscribed: false,
    });
    expect(provider).toBe("opt_out");
    expect(db.row!.emailPreferenceSyncedAt).toEqual(T1);
  });

  it("follows a newer choice that lands while the provider is being set", async () => {
    setTopic.mockImplementationOnce(async (_e, choice) => {
      provider = choice;
      // Another request records a Subscribe again meanwhile.
      Object.assign(db.row!, { unsubscribedAt: null, emailPreferenceAt: T2 });
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toEqual({ subscribed: true });
    expect(setTopic.mock.calls.map((c) => c[1])).toEqual(["opt_out", "opt_in"]);
    expect(db.row!.emailPreferenceSyncedAt).toEqual(T2);
  });

  it("leaves it unsynced, for the scheduled run, when the provider fails", async () => {
    setTopic.mockResolvedValueOnce(false);
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(db.row!.emailPreferenceSyncedAt).toBeNull();
  });

  it("gives up after three rounds of choices changing underneath it", async () => {
    let t = +T2;
    setTopic.mockImplementation(async () => {
      db.row!.emailPreferenceAt = new Date((t += 1));
      return true;
    });
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(setTopic).toHaveBeenCalledTimes(3);
  });

  it("does nothing for an account with no recorded choice", async () => {
    db.row!.emailPreferenceAt = null;
    expect(await syncEmailPreference("u1", "kai@acme.dev", setTopic)).toBeNull();
    expect(setTopic).not.toHaveBeenCalled();
  });
});

describe("syncPendingEmailPreferences", () => {
  it("syncs what is pending and counts what is left", async () => {
    db.pending = [{ user_id: "u1", email: "kai@acme.dev" }];
    expect(await syncPendingEmailPreferences({ setTopic })).toEqual({ synced: 1, pending: 0 });
    setTopic.mockResolvedValueOnce(false);
    db.row!.emailPreferenceSyncedAt = null;
    expect(await syncPendingEmailPreferences({ setTopic })).toEqual({ synced: 0, pending: 1 });
  });
});
