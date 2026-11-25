import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unsubscribe page, the account writes, the provider sync and the scheduled
 * tick against a real, migrated Postgres, with a fake provider that can hold,
 * fail, or apply a write and never answer (its request is lost). Runs only when
 * EMAIL_PREFERENCE_TEST_DATABASE_URL points at a throwaway database:
 *
 *   cd frontend/packages/core && DATABASE_URL=<url> pnpm exec prisma migrate deploy
 *   cd frontend/ui && EMAIL_PREFERENCE_TEST_DATABASE_URL=<url> \
 *     pnpm exec vitest run src/lib/lifecycle/email-preference.db.test.ts
 *
 * Synthetic accounts only; nothing leaves the machine.
 */
const DATABASE_URL = process.env.EMAIL_PREFERENCE_TEST_DATABASE_URL;

const jobs = vi.hoisted(() => ({
  traceCountsFail: false,
  newsletterFail: false,
  newsletterRuns: 0,
}));
vi.mock("@/env", () => ({ env: process.env }));
vi.mock("@/lib/trace-count", () => ({
  reportDailyTraceCounts: async () => {
    if (jobs.traceCountsFail) throw new Error("trace report down");
    return { kind: "skipped" };
  },
}));
vi.mock("@/lib/newsletter-job", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/newsletter-job")>();
  return {
    ...actual,
    runNewsletterJob: async (...args: Parameters<typeof actual.runNewsletterJob>) => {
      jobs.newsletterRuns += 1;
      if (jobs.newsletterFail) throw new Error("newsletter down");
      return actual.runNewsletterJob(...args);
    },
  };
});

// The provider: contacts, the product topic per address, and the ways a write
// can go wrong.
const provider = {
  topic: new Map<string, string>(),
  contacts: new Set<string>(),
  failNext: 0,
  failAlways: new Set<string>(),
  // The next write of this choice waits for the gate, lands, and then either
  // answers or (lost) never answers its request.
  hold: null as null | { choice: string; gate: Promise<void>; lost: boolean; failAfter: number },
};
const fakeProvider = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname !== "api.resend.com") throw new Error(`unexpected ${url.hostname}`);
  const parts = url.pathname.split("/").map(decodeURIComponent);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  if (parts[1] !== "contacts") return new Response("{}", { status: 404 });
  if (!parts[3]) {
    if (method === "GET")
      return provider.contacts.has(parts[2])
        ? Response.json({})
        : new Response("{}", { status: 404 });
    provider.contacts.add(body.email);
    return Response.json({ id: "c" });
  }
  const choice = body[0].subscription as string;
  if (provider.hold?.choice === choice) {
    const held = provider.hold;
    provider.hold = null;
    await held.gate;
    provider.topic.set(parts[2], choice);
    // A correction right after a stale write lands can fail too.
    provider.failNext += held.failAfter;
    if (held.lost) return new Promise<Response>(() => {});
    return Response.json({ id: "c" });
  }
  if (provider.failAlways.has(parts[2])) return new Response("{}", { status: 503 });
  if (provider.failNext > 0) {
    provider.failNext -= 1;
    return new Response("{}", { status: 503 });
  }
  provider.topic.set(parts[2], choice);
  return Response.json({ id: "c" });
}) as typeof fetch;

type Prisma = import("@prisma/client").PrismaClient;
let prisma: Prisma;
let unsubscribe: typeof import("@/app/api/email/unsubscribe/route");
let tickRoute: typeof import("@/app/api/internal/scheduled-tick/route");
let sync: typeof import("./email-preference-sync");
let signToken: (email: string) => string;
const TAG = `prefdb${Date.now()}`;
const TICK_SECRET = `tick-${Math.random().toString(36).slice(2)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (email: string, action: "opt_in" | "opt_out") => {
  const response = await unsubscribe.POST(
    new Request("http://localhost/api/email/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `t=${encodeURIComponent(signToken(email))}&action=${action}`,
    }),
  );
  return { status: response.status, text: await response.text() };
};
let n = 0;
async function person() {
  const id = `${TAG}-${(n += 1)}`;
  const email = `${id}@acme-e2e.dev`;
  await prisma.user.create({ data: { id, email, name: id } });
  return { id, email };
}
const account = (id: string) => prisma.userOnboarding.findUnique({ where: { userId: id } });
const unsubscribed = async (id: string) => !!(await account(id))?.unsubscribedAt;
// Whether the provider holds the account's choice.
const agree = async (p: { id: string; email: string }) =>
  provider.topic.get(p.email) === ((await unsubscribed(p.id)) ? "opt_out" : "opt_in");
// The scheduled run, with the settle window already over.
const run = (options: { limit?: number } = {}) =>
  sync.syncPendingEmailPreferences({ settleAfterMs: 0, ...options });
const tick = async () =>
  (
    await tickRoute.POST(
      new Request("http://localhost/api/internal/scheduled-tick", {
        method: "POST",
        headers: { "X-Internal-Secret": TICK_SECRET },
      }) as never,
    )
  ).json();

describe.skipIf(!DATABASE_URL)("product-email choices against a real database", () => {
  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL,
      RESEND_API_KEY: "re_local_stub_only",
      RESEND_PRODUCT_TOPIC_ID: "topic_local",
      TRACEROOT_UNSUBSCRIBE_TOKEN_SECRET: "local-unsubscribe-secret-0123456789abcdef",
      INTERNAL_API_SECRET: TICK_SECRET,
      // The tick route loads the auth module, which reads these at import.
      BETTER_AUTH_URL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
      BETTER_AUTH_SECRET:
        process.env.BETTER_AUTH_SECRET || "local-test-secret-0123456789abcdef0123",
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
    });
    vi.stubGlobal("fetch", fakeProvider);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    ({ prisma } = (await import("@traceroot/core")) as unknown as { prisma: Prisma });
    ({ signUnsubscribeToken: signToken } = await import("@traceroot/core/email"));
    unsubscribe = await import("@/app/api/email/unsubscribe/route");
    tickRoute = await import("@/app/api/internal/scheduled-tick/route");
    sync = await import("./email-preference-sync");
  });

  beforeEach(() => {
    provider.failNext = 0;
    provider.failAlways.clear();
    provider.hold = null;
    Object.assign(jobs, { traceCountsFail: false, newsletterFail: false, newsletterRuns: 0 });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { startsWith: TAG } } });
    await prisma.$disconnect();
  });

  // Release criteria: both orderings, the stale write landing after the newer
  // choice completed, and the correction of it failing with a 503.
  it.each([
    ["an old Subscribe again", "opt_in", "opt_out"],
    ["an old unsubscribe", "opt_out", "opt_in"],
  ] as const)(
    "%s held, a newer choice completes, the stale write lands and its correction gets a 503: the next run restores the newer choice",
    async (_case, older, newer) => {
      const p = await person();
      await post(p.email, older === "opt_in" ? "opt_out" : "opt_in");
      await sleep(5);
      let release!: () => void;
      provider.hold = {
        choice: older,
        gate: new Promise<void>((r) => (release = r)),
        lost: false,
        failAfter: 1,
      };
      const stale = post(p.email, older);
      await sleep(80);
      expect((await post(p.email, newer)).status).toBe(200);
      expect(provider.topic.get(p.email)).toBe(newer);
      release();
      await stale;
      // The stale write is at the provider, its correction failed.
      expect(provider.topic.get(p.email)).toBe(older);
      expect(await unsubscribed(p.id)).toBe(newer === "opt_out");
      const first = await run();
      expect(first.synced).toBeGreaterThanOrEqual(1);
      expect(provider.topic.get(p.email)).toBe(newer);
      expect(await agree(p)).toBe(true);
      // And the run after sees nothing left, with the two in agreement.
      expect(await run()).toEqual({ synced: 0, pending: 0 });
      expect(await agree(p)).toBe(true);
    },
  );

  it("restores an unsubscribe after a stale opt-in landed and its request was lost", async () => {
    const p = await person();
    await post(p.email, "opt_out");
    await sleep(5);
    let land!: () => void;
    provider.hold = {
      choice: "opt_in",
      gate: new Promise<void>((r) => (land = r)),
      lost: true,
      failAfter: 0,
    };
    void post(p.email, "opt_in"); // its worker never continues
    await sleep(80);
    expect((await post(p.email, "opt_out")).status).toBe(200);
    land();
    await sleep(50);
    expect(provider.topic.get(p.email)).toBe("opt_in");
    expect(await unsubscribed(p.id)).toBe(true);
    await run();
    expect(provider.topic.get(p.email)).toBe("opt_out");
  });

  it("keeps the newer choice when a Subscribe again lands after it, and the reverse", async () => {
    for (const [older, newer] of [
      ["opt_in", "opt_out"],
      ["opt_out", "opt_in"],
    ] as const) {
      const p = await person();
      await post(p.email, newer === "opt_out" ? "opt_in" : "opt_out");
      await sleep(5);
      let release!: () => void;
      provider.hold = {
        choice: older,
        gate: new Promise<void>((r) => (release = r)),
        lost: false,
        failAfter: 0,
      };
      const slow = post(p.email, older);
      await sleep(80);
      await post(p.email, newer);
      release();
      const late = await slow;
      expect(late.status).toBe(200);
      expect(await unsubscribed(p.id)).toBe(newer === "opt_out");
      expect(provider.topic.get(p.email)).toBe(newer);
      expect(late.text.includes("You're unsubscribed.")).toBe(newer === "opt_out");
    }
  });

  it("tells same-millisecond choices apart, and the unsubscribe wins", async () => {
    const pause = await import("./pause");
    const p = await person();
    const at = await pause.emailChoiceTime();
    await pause.recordUnsubscribe(p.email, true, at);
    let first = true;
    const result = await sync.syncEmailPreference(p.id, p.email, async (email, choice) => {
      provider.topic.set(email, choice);
      if (first) {
        first = false;
        await pause.recordUnsubscribe(email, false, at);
      }
      return true;
    });
    expect(result).toEqual({ subscribed: false });
    expect(provider.topic.get(p.email)).toBe("opt_out");
    // A Subscribe again at that same instant changes nothing now.
    expect(await pause.recordUnsubscribe(p.email, true, at)).toMatchObject({ applied: false });
    const row = await account(p.id);
    expect(row?.emailPreferenceVersion).toBe(2);
  });

  it("does not let a cohort the provider always refuses hold up someone else", async () => {
    const cohort = [];
    for (let i = 0; i < 6; i += 1) {
      const p = await person();
      provider.failAlways.add(p.email);
      await post(p.email, "opt_out");
      cohort.push(p);
    }
    const healthy = await person();
    provider.failNext = 1;
    await post(healthy.email, "opt_out");
    expect(provider.topic.has(healthy.email)).toBe(false);
    for (let i = 0; i < 3 && provider.topic.get(healthy.email) !== "opt_out"; i += 1)
      await run({ limit: 5 });
    expect(provider.topic.get(healthy.email)).toBe("opt_out");
    provider.failAlways.clear();
    await run({ limit: 50 });
  });

  it("waits out the settle window after a write before confirming it", async () => {
    const p = await person();
    await post(p.email, "opt_out");
    await sync.syncPendingEmailPreferences({ settleAfterMs: 60_000 });
    const row = await account(p.id);
    expect(row?.emailProviderSettledAt).toBeNull();
    await run();
    const after = await account(p.id);
    expect(after?.emailProviderSettledAt).toEqual(after?.emailProviderWriteAt);
  });

  it("answers an error and changes nothing when the account write fails on a Subscribe again", async () => {
    const p = await person();
    await post(p.email, "opt_out");
    await run();
    const fixture = `${TAG.replace(/\W/g, "")}_fail`;
    await prisma.$executeRawUnsafe(
      `create function ${fixture}() returns trigger language plpgsql as $$ begin if new.user_id = '${p.id}' then raise exception 'local fixture: write refused'; end if; return new; end $$`,
    );
    await prisma.$executeRawUnsafe(
      `create trigger ${fixture} before update on user_onboarding for each row execute function ${fixture}()`,
    );
    try {
      expect((await post(p.email, "opt_in")).status).toBe(502);
    } finally {
      await prisma.$executeRawUnsafe(`drop trigger ${fixture} on user_onboarding`);
      await prisma.$executeRawUnsafe(`drop function ${fixture}()`);
    }
    expect(await unsubscribed(p.id)).toBe(true);
    expect(provider.topic.get(p.email)).toBe("opt_out");
  });

  it("runs the preference sync and the newsletter in the real tick when an unrelated job fails", async () => {
    const p = await person();
    provider.failNext = 1;
    await post(p.email, "opt_out"); // its sync is left for the run
    // The run confirms only writes older than the window; make this one old.
    await prisma.userOnboarding.update({
      where: { userId: p.id },
      data: { emailProviderWriteAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    jobs.traceCountsFail = true;
    const body = await tick();
    expect(body.traceCounts).toEqual({ error: "failed" });
    expect(body.emailPreferences.synced).toBeGreaterThanOrEqual(1);
    expect(provider.topic.get(p.email)).toBe("opt_out");
    expect(jobs.newsletterRuns).toBe(1);
    expect(body.newsletter).not.toEqual({ error: "failed" });

    // And the other way round: the newsletter fails, the preference sync still runs.
    const q = await person();
    provider.failNext = 1;
    await post(q.email, "opt_out");
    await prisma.userOnboarding.update({
      where: { userId: q.id },
      data: { emailProviderWriteAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    jobs.traceCountsFail = false;
    jobs.newsletterFail = true;
    const second = await tick();
    expect(second.newsletter).toEqual({ error: "failed" });
    expect(second.emailPreferences.synced).toBeGreaterThanOrEqual(1);
    expect(provider.topic.get(q.email)).toBe("opt_out");
  });
});
