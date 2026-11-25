import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The unsubscribe page, the account writes, the provider sync and the scheduled
 * tick against a real, migrated Postgres, with a fake provider that can hold,
 * fail, or apply a write and never answer (its request is lost), served over
 * HTTP on a local port that the provider's address is pointed at. Runs only when
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
  segments: new Map<string, Set<string>>(),
  slowMs: 0,
  // The next write of this choice waits for the gate, lands, and then either
  // answers or (lost) never answers its request.
  hold: null as null | { choice: string; gate: Promise<void>; lost: boolean; failAfter: number },
};
const handle = async (url: URL, init: { method: string; body: string }) => {
  const parts = url.pathname.split("/").map(decodeURIComponent);
  const method = init.method;
  const body = init.body ? JSON.parse(init.body) : null;
  if (parts[1] !== "contacts") return new Response("{}", { status: 404 });
  if (!parts[3]) {
    if (method === "GET")
      return provider.contacts.has(parts[2])
        ? Response.json({ email: parts[2], unsubscribed: false })
        : new Response("{}", { status: 404 });
    provider.contacts.add(body.email);
    return Response.json({ id: "c" });
  }
  // The newsletter job's reads and segment adds.
  if (parts[3] === "topics" && method === "GET") {
    const subscription = provider.topic.get(parts[2]) ?? "opt_in";
    return Response.json({ data: [{ id: "topic_local", subscription }], has_more: false });
  }
  if (parts[3] === "segments" && method === "POST") {
    const set = provider.segments.get(parts[2]) ?? new Set<string>();
    provider.segments.set(parts[2], set.add(parts[4]));
    return Response.json({ id: parts[4] });
  }
  const choice = body[0].subscription as string;
  if (provider.slowMs) await sleep(provider.slowMs);
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
};

// The fake provider on a local port; requests for the provider's address are
// sent there instead, over real HTTP.
let server: Server;
const realFetch = globalThis.fetch;
const startProvider = async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const response = await handle(new URL(req.url!, "http://provider"), {
        method: req.method ?? "GET",
        body,
      });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname !== "api.resend.com") throw new Error(`unexpected ${url.hostname}`);
    return realFetch(`${base}${url.pathname}${url.search}`, init);
  }) as typeof fetch;
};

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
async function person(createdAt = new Date()) {
  const id = `${TAG}-${(n += 1)}`;
  const email = `${id}@acme-e2e.dev`;
  await prisma.user.create({ data: { id, email, name: id, createdAt } });
  return { id, email };
}
const account = (id: string) => prisma.userOnboarding.findUnique({ where: { userId: id } });
const unsubscribed = async (id: string) => !!(await account(id))?.unsubscribedAt;
// Whether the provider holds the account's choice.
const agree = async (p: { id: string; email: string }) =>
  provider.topic.get(p.email) === ((await unsubscribed(p.id)) ? "opt_out" : "opt_in");
// Makes the person's latest provider write older than the settle window.
const windowPassed = (id: string) =>
  prisma.$executeRawUnsafe(
    `update user_onboarding set email_provider_write_at = email_provider_write_at - interval '1 hour', email_provider_settled_at = email_provider_settled_at - interval '1 hour' where user_id = $1`,
    id,
  );
const settled = async (id: string) => {
  const row = await account(id);
  return !!row?.emailProviderSettledAt && +row.emailProviderWriteAt! <= +row.emailProviderSettledAt;
};
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
    vi.stubGlobal("fetch", await startProvider());
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
    provider.slowMs = 0;
    Object.assign(jobs, { traceCountsFail: false, newsletterFail: false, newsletterRuns: 0 });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: { startsWith: TAG } } });
    await prisma.$disconnect();
    server?.closeAllConnections();
    server?.close();
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
      // Two real scheduled ticks, each after the settle window has passed.
      await windowPassed(p.id);
      const first = await tick();
      expect(first.emailPreferences.synced).toBeGreaterThanOrEqual(1);
      expect(provider.topic.get(p.email)).toBe(newer);
      expect(await agree(p)).toBe(true);
      expect(await settled(p.id)).toBe(true);
      await windowPassed(p.id);
      const second = await tick();
      expect(await agree(p)).toBe(true);
      expect(await settled(p.id)).toBe(true);
      expect(second.newsletter).not.toEqual({ error: "failed" });
    },
  );

  it("carries normal changes, both ways and repeated, to the account and the provider", async () => {
    const p = await person();
    for (const choice of ["opt_out", "opt_out", "opt_in", "opt_out", "opt_in"] as const) {
      await sleep(3);
      const response = await post(p.email, choice);
      expect(response.status).toBe(200);
      expect(await unsubscribed(p.id)).toBe(choice === "opt_out");
      expect(provider.topic.get(p.email)).toBe(choice);
    }
    await windowPassed(p.id);
    await tick();
    expect(await settled(p.id)).toBe(true);
    expect(await agree(p)).toBe(true);
  });

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

  it("records a newer unsubscribe even when an older one lands while it is being applied", async () => {
    // Three ordinary choices: an unsubscribe at t1, an unsubscribe at t3, and a
    // Subscribe again at t2 that arrives last. The older unsubscribe commits
    // while the newer one is waiting on the row.
    const pause = await import("./pause");
    const p = await person();
    await post(p.email, "opt_in");
    const t0 = (await account(p.id))!.emailPreferenceAt!;
    const [t1, t2, t3] = [1, 2, 3].map((i) => new Date(+t0 + i * 1000));
    let newer!: Promise<unknown>;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM user_onboarding WHERE user_id = ${p.id} FOR UPDATE`;
      newer = pause.recordUnsubscribe(p.email, false, t3); // waits for the row
      await sleep(300);
      // The older unsubscribe's effect, committed while the newer one waits.
      await tx.userOnboarding.update({
        where: { userId: p.id },
        data: {
          unsubscribedAt: t1,
          emailPreferenceAt: t1,
          emailPreferenceVersion: { increment: 1 },
        },
      });
    });
    expect(await newer).toMatchObject({ applied: true, subscribed: false });
    expect(await pause.recordUnsubscribe(p.email, true, t2)).toMatchObject({
      applied: false,
      subscribed: false,
    });
    const row = await account(p.id);
    expect(row?.emailPreferenceAt).toEqual(t3);
    expect(row?.unsubscribedAt).toEqual(t1); // the first unsubscribe's time is kept
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

  it("with the newsletter on, keeps a pending Subscribe again and still records a genuine provider opt-out", async () => {
    const newsletterOn = {
      NEWSLETTER_SEGMENT_ENABLED: "true",
      RESEND_NEWSLETTER_SEGMENT_ID: "seg_local",
      NEWSLETTER_START_AT: "2020-01-01T00:00:00Z",
      TRACEROOT_CLOUD_ENV: "staging",
    };
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000); // due for the newsletter
    const inSegment = (email: string) => provider.segments.get(email)?.has("seg_local") ?? false;

    // Someone whose choice was confirmed at the provider, before the newsletter is on.
    const genuine = await person(old);
    await post(genuine.email, "opt_in");
    await windowPassed(genuine.id);
    await tick();
    expect(await settled(genuine.id)).toBe(true);

    // Someone who unsubscribed, then deliberately subscribed again while the
    // provider answered 503: the account says subscribed, the provider still opt_out.
    const back = await person(old);
    await post(back.email, "opt_out");
    await windowPassed(back.id);
    await tick();
    await sleep(5);
    provider.failNext = 1;
    expect((await post(back.email, "opt_in")).status).toBe(200);
    expect(await unsubscribed(back.id)).toBe(false);
    expect(provider.topic.get(back.email)).toBe("opt_out");

    // The genuine one opts out at the provider itself.
    provider.topic.set(genuine.email, "opt_out");

    const saved = { ...process.env };
    Object.assign(process.env, newsletterOn);
    try {
      // The newsletter runs before the Subscribe again's provider sync is due.
      const first = await tick();
      expect(first.newsletter.excluded?.provider_unsubscribed).toBeGreaterThanOrEqual(2);
      expect(inSegment(back.email)).toBe(false);
      expect(await unsubscribed(back.id)).toBe(false); // the account's choice stands
      expect(await unsubscribed(genuine.id)).toBe(true); // the provider's opt-out is recorded
      expect(inSegment(genuine.email)).toBe(false);

      // Once the window has passed, the provider follows the Subscribe again, and
      // the newsletter adds them; the genuine opt-out stays as it is.
      await windowPassed(back.id);
      await windowPassed(genuine.id);
      await tick();
      expect(provider.topic.get(back.email)).toBe("opt_in");
      await tick();
      expect(inSegment(back.email)).toBe(true);
      expect(provider.topic.get(genuine.email)).toBe("opt_out");
      expect(await unsubscribed(genuine.id)).toBe(true);
      expect(inSegment(genuine.email)).toBe(false);
    } finally {
      for (const key of Object.keys(newsletterOn)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });

  it("keeps an opt-out made at the provider after an acknowledged Subscribe again, and the newsletter leaves them out", async () => {
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    const p = await person(old);
    await post(p.email, "opt_out");
    await windowPassed(p.id);
    await tick();
    await sleep(5);
    // A Subscribe again the provider acknowledged...
    expect((await post(p.email, "opt_in")).status).toBe(200);
    expect(provider.topic.get(p.email)).toBe("opt_in");
    const acked = await account(p.id);
    expect(acked?.emailProviderAckVersion).toBe(acked?.emailPreferenceVersion);
    // ...then the person opts out at the provider itself (no time from it).
    provider.topic.set(p.email, "opt_out");
    await windowPassed(p.id);
    const saved = { ...process.env };
    Object.assign(process.env, {
      NEWSLETTER_SEGMENT_ENABLED: "true",
      RESEND_NEWSLETTER_SEGMENT_ID: "seg_local",
      NEWSLETTER_START_AT: "2020-01-01T00:00:00Z",
      TRACEROOT_CLOUD_ENV: "staging",
    });
    try {
      for (let i = 0; i < 2; i += 1) await tick();
    } finally {
      for (const key of [
        "NEWSLETTER_SEGMENT_ENABLED",
        "RESEND_NEWSLETTER_SEGMENT_ID",
        "NEWSLETTER_START_AT",
        "TRACEROOT_CLOUD_ENV",
      ]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
    expect(provider.topic.get(p.email)).toBe("opt_out"); // not set back to opt-in
    expect(await unsubscribed(p.id)).toBe(true); // recorded on the account
    expect(provider.segments.get(p.email)?.has("seg_local") ?? false).toBe(false);
    expect(await settled(p.id)).toBe(true);
  });

  it("leaves the newsletter its turn within the worker's timeout when the provider is slow", async () => {
    const { WEB_TICK_TIMEOUT_MS } = { WEB_TICK_TIMEOUT_MS: 60_000 }; // worker/src/web-tick
    const due = [];
    for (let i = 0; i < 15; i += 1) {
      const p = await person();
      provider.failNext = 1;
      await post(p.email, "opt_out"); // left for the run
      await windowPassed(p.id);
      due.push(p);
    }
    provider.slowMs = 1_500; // every provider write takes 1.5 s
    const started = Date.now();
    const body = await tick();
    const took = Date.now() - started;
    // Stopped starting people after its budget, and said how many are left...
    expect(body.emailPreferences.remaining).toBeGreaterThan(0);
    expect(body.emailPreferences.synced).toBeGreaterThan(0);
    // ...so the newsletter still ran, and the whole tick fits the worker's timeout.
    expect(jobs.newsletterRuns).toBe(1);
    expect(body.newsletter).not.toEqual({ error: "failed" });
    expect(took).toBeLessThan(WEB_TICK_TIMEOUT_MS);
    // The next ticks finish the rest.
    provider.slowMs = 0;
    for (let i = 0; i < 3; i += 1) await tick();
    for (const p of due) expect(await agree(p)).toBe(true);
  }, 90_000);
});
