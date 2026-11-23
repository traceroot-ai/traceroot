// The newsletter audience against an in-memory stand-in for the two tables it
// reads and a fake provider that records every call, so nothing leaves the test.
import { beforeEach, describe, expect, it } from "vitest";
import {
  localExclusion,
  NEWSLETTER_DELAY_MS,
  runNewsletterAudience,
  type AudienceClient,
} from "../lib/email/newsletter.ts";

const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-12-01T00:00:00Z");
const ENV = {
  RESEND_API_KEY: "re_test",
  RESEND_PRODUCT_TOPIC_ID: "topic_product",
  RESEND_NEWSLETTER_SEGMENT_ID: "seg_news",
  NEWSLETTER_START_AT: START.toISOString(),
  SKIP_EMAILS: "qa+1@acme.test",
} as NodeJS.ProcessEnv;

type User = {
  id: string;
  email: string;
  createdAt: Date;
  accounts: { providerId: string }[];
  onboarding: { unsubscribedAt: Date | null; newsletterAddedAt: Date | null } | null;
};
let users: User[];

const inRange = (at: Date, r: { gte?: Date; lte?: Date; lt?: Date }) =>
  (!r.gte || at >= r.gte) && (!r.lte || at <= r.lte) && (!r.lt || at < r.lt);
const pending = (where: { createdAt: Record<string, Date> }) =>
  users
    .filter((u) => inRange(u.createdAt, where.createdAt) && !u.onboarding?.newsletterAddedAt)
    .sort((a, b) => +a.createdAt - +b.createdAt);
const row = (userId: string) => {
  const user = users.find((u) => u.id === userId)!;
  user.onboarding ??= { unsubscribedAt: null, newsletterAddedAt: null };
  return user.onboarding;
};
const db = {
  user: {
    findMany: async ({
      where,
      take,
    }: {
      where: { createdAt: Record<string, Date> };
      take?: number;
    }) => pending(where).slice(0, take ?? Infinity),
    count: async ({ where }: { where: { createdAt: Record<string, Date> } }) =>
      pending(where).length,
  },
  userOnboarding: {
    createMany: async ({ data }: { data: { userId: string }[] }) => {
      data.forEach((d) => row(d.userId));
      return { count: data.length };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { userId: string } & Record<string, null | string>;
      data: Record<string, Date>;
    }) => {
      const r = row(where.userId);
      const field = Object.keys(where).find((k) => k !== "userId") as keyof typeof r;
      if (r[field] !== null) return { count: 0 };
      Object.assign(r, data);
      return { count: 1 };
    },
  },
} as unknown as AudienceClient;

/** The provider: contacts by address, and what each call did. */
type Contact = { unsubscribed?: boolean; productTopic?: "opt_in" | "opt_out" };
let contacts: Map<string, Contact>;
let segment: Set<string>;
let calls: string[];
let down: Set<string>;
const fetchImpl = (async (url: string, init: { method: string }) => {
  const { pathname } = new URL(url);
  const parts = pathname.split("/").map(decodeURIComponent);
  const email = parts[2];
  calls.push(`${init.method} ${parts.slice(3).join("/") || "contact"}`);
  if (down.has(email)) return new Response("{}", { status: 503 });
  if (init.method === "POST" && parts[1] === "contacts" && parts.length === 2) {
    return Response.json({ id: "c" });
  }
  if (init.method === "GET" && parts.length === 3) {
    const contact = contacts.get(email);
    if (!contact) return new Response("{}", { status: 404 });
    return Response.json({ email, unsubscribed: !!contact.unsubscribed });
  }
  if (init.method === "GET" && parts[3] === "topics") {
    const sub = contacts.get(email)?.productTopic ?? "opt_in";
    return Response.json({ data: [{ id: "topic_product", subscription: sub }] });
  }
  if (init.method === "POST" && parts[3] === "segments") {
    segment.add(email);
    return Response.json({ id: parts[4] });
  }
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

// ensureContact POSTs /contacts with the address in the body.
const realFetch = fetchImpl;
const providerFetch = (async (url: string, init: { method: string; body?: string }) => {
  if (init.method === "POST" && new URL(url).pathname === "/contacts") {
    const { email } = JSON.parse(init.body!);
    calls.push("POST contact");
    if (down.has(email)) return new Response("{}", { status: 503 });
    contacts.set(email, {});
    return Response.json({ id: "c" });
  }
  return realFetch(url, init as RequestInit);
}) as unknown as typeof fetch;

function person(
  id: string,
  createdAt: Date,
  opts: Partial<User> & { contact?: Contact | null } = {},
) {
  const email = opts.email ?? `${id}@acme.test`;
  users.push({
    id,
    email,
    createdAt,
    accounts: opts.accounts ?? [{ providerId: "credential" }],
    onboarding: opts.onboarding ?? null,
  });
  if (opts.contact !== null) contacts.set(email, opts.contact ?? {});
}
const run = (
  opts: { kind: "import" } | { kind: "scheduled"; now: Date },
  apply: boolean,
  limit?: number,
) =>
  runNewsletterAudience(db, {
    mode: opts,
    apply,
    limit,
    env: ENV,
    fetchImpl: providerFetch,
    minIntervalMs: 0,
    log: () => {},
  });

beforeEach(() => {
  users = [];
  contacts = new Map();
  segment = new Set();
  calls = [];
  down = new Set();
});

describe("who is left out", () => {
  const settings = { teamDomains: ["traceroot.ai"], skipEmails: ["qa+1@acme.test"] };
  it.each<[string, Parameters<typeof localExclusion>[0], string | null]>([
    [
      "a work address",
      { email: "kai@acme.test", providers: ["credential"], unsubscribedAt: null },
      null,
    ],
    [
      "the team",
      { email: "Lee@TraceRoot.ai", providers: ["google"], unsubscribedAt: null },
      "team_account",
    ],
    [
      "a team subdomain",
      { email: "ci@eng.traceroot.ai", providers: [], unsubscribedAt: null },
      "team_account",
    ],
    [
      "not the team, only similar",
      { email: "x@nottraceroot.ai", providers: [], unsubscribedAt: null },
      null,
    ],
    [
      "a listed test account",
      { email: "QA+1@acme.test", providers: [], unsubscribedAt: null },
      "listed_test_account",
    ],
    [
      "an AI agent",
      { email: "a1@agents.test", providers: ["agentid"], unsubscribedAt: null },
      "agent_account",
    ],
    [
      "unsubscribed here",
      { email: "kai@acme.test", providers: [], unsubscribedAt: new Date() },
      "unsubscribed",
    ],
  ])("%s", (_who, who, reason) => {
    expect(localExclusion(who, settings)).toBe(reason);
  });
});

describe("the one-time import", () => {
  beforeEach(() => {
    person("old1", new Date(START.getTime() - 30 * DAY));
    person("old2", new Date(START.getTime() - 2 * DAY), { contact: null });
    person("team", new Date(START.getTime() - 9 * DAY), { email: "lee@traceroot.ai" });
    person("qa", new Date(START.getTime() - 9 * DAY), { email: "qa+1@acme.test" });
    person("agent", new Date(START.getTime() - 9 * DAY), { accounts: [{ providerId: "agentid" }] });
    person("unsub", new Date(START.getTime() - 9 * DAY), {
      onboarding: { unsubscribedAt: new Date(), newsletterAddedAt: null },
    });
    person("optout", new Date(START.getTime() - 9 * DAY), { contact: { productTopic: "opt_out" } });
    person("gone", new Date(START.getTime() - 9 * DAY), { contact: { unsubscribed: true } });
    person("new", START);
  });

  it("a dry run counts, writes nothing, and calls only the provider's reads", async () => {
    const counted = await run({ kind: "import" }, false);
    expect(counted).toMatchObject({
      considered: 8,
      added: 2,
      withoutContact: 1,
      failed: 0,
      excluded: {
        team_account: 1,
        listed_test_account: 1,
        agent_account: 1,
        unsubscribed: 1,
        provider_unsubscribed: 2,
      },
    });
    expect(calls.every((c) => c.startsWith("GET"))).toBe(true);
    expect(segment.size).toBe(0);
    expect(users.every((u) => !u.onboarding?.newsletterAddedAt)).toBe(true);
    expect(users.find((u) => u.id === "optout")!.onboarding).toBeNull();
  });

  it("applied, adds exactly what the dry run counted, making a contact where there is none", async () => {
    const dry = await run({ kind: "import" }, false);
    const applied = await run({ kind: "import" }, true);
    expect(applied.added).toBe(dry.added);
    expect([...segment].sort()).toEqual(["old1@acme.test", "old2@acme.test"]);
    expect(contacts.has("old2@acme.test")).toBe(true);
    // Never someone who signed up from the start; the scheduled job takes them.
    expect(segment.has("new@acme.test")).toBe(false);
    // A provider opt-out is recorded here too, for the follow-ups.
    expect(users.find((u) => u.id === "optout")!.onboarding!.unsubscribedAt).toBeInstanceOf(Date);
  });

  it("run again, adds nobody twice", async () => {
    await run({ kind: "import" }, true);
    calls = [];
    const again = await run({ kind: "import" }, true);
    expect(again.added).toBe(0);
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });

  it("stopped part way, the next run finishes the rest", async () => {
    const first = await run({ kind: "import" }, true, 1);
    expect(first).toMatchObject({ considered: 1, added: 1 });
    expect(first.remaining).toBeGreaterThan(0);
    const rest = await run({ kind: "import" }, true);
    expect(rest.added).toBe(1);
    expect(segment.size).toBe(2);
  });

  it("someone the provider cannot be reached for is not stamped, and is added on the retry", async () => {
    down.add("old1@acme.test");
    const first = await run({ kind: "import" }, true);
    expect(first).toMatchObject({ added: 1, failed: 1 });
    expect(users.find((u) => u.id === "old1")!.onboarding?.newsletterAddedAt ?? null).toBeNull();
    down.clear();
    expect(await run({ kind: "import" }, true)).toMatchObject({ added: 1, failed: 0 });
    expect(segment.has("old1@acme.test")).toBe(true);
  });

  it("two imports at once add each person once to the segment and stamp once", async () => {
    await Promise.all([run({ kind: "import" }, true), run({ kind: "import" }, true)]);
    expect(segment.size).toBe(2);
    expect(users.filter((u) => u.onboarding?.newsletterAddedAt)).toHaveLength(2);
  });
});

describe("the 14-day job", () => {
  const signedUp = new Date(START.getTime() + 2 * DAY);
  const at14 = new Date(signedUp.getTime() + NEWSLETTER_DELAY_MS);

  it("adds a new sign-up at 14 days, not a moment before", async () => {
    person("n1", signedUp);
    expect(await run({ kind: "scheduled", now: new Date(at14.getTime() - 1) }, true)).toMatchObject(
      {
        considered: 0,
      },
    );
    expect(await run({ kind: "scheduled", now: at14 }, true)).toMatchObject({ added: 1 });
    expect(segment.has("n1@acme.test")).toBe(true);
    // The next tick finds them added.
    expect(
      await run({ kind: "scheduled", now: new Date(at14.getTime() + DAY) }, true),
    ).toMatchObject({ considered: 0 });
  });

  it("never takes someone who signed up before the start; that is the import's", async () => {
    person("old", new Date(START.getTime() - DAY));
    expect(await run({ kind: "scheduled", now: at14 }, true)).toMatchObject({ considered: 0 });
  });

  it("leaves out an unsubscribed new sign-up", async () => {
    person("n1", signedUp, { onboarding: { unsubscribedAt: new Date(), newsletterAddedAt: null } });
    expect(await run({ kind: "scheduled", now: at14 }, true)).toMatchObject({
      added: 0,
      excluded: { unsubscribed: 1 },
    });
    expect(segment.size).toBe(0);
  });

  it("works through a backlog a batch at a time", async () => {
    for (let i = 0; i < 5; i += 1) person(`n${i}`, signedUp);
    expect(await run({ kind: "scheduled", now: at14 }, true, 2)).toMatchObject({
      added: 2,
      remaining: 3,
    });
  });
});

describe("does nothing without its settings", () => {
  it.each([
    ["RESEND_NEWSLETTER_SEGMENT_ID", "no_segment"],
    ["RESEND_API_KEY", "no_api_key"],
    ["NEWSLETTER_START_AT", "no_start"],
  ])("without %s", async (name, reason) => {
    person("old1", new Date(START.getTime() - DAY));
    const result = await runNewsletterAudience(db, {
      mode: { kind: "import" },
      apply: true,
      env: { ...ENV, [name]: "" },
      fetchImpl: providerFetch,
      log: () => {},
    });
    expect(result.notRun).toBe(reason);
    expect(calls).toEqual([]);
  });
});
