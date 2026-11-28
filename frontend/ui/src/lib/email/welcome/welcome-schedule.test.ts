// The welcome's timing against an in-memory stand-in for the three tables it
// touches. sendOnce, the claim and the provider call are the real ones; only
// the network is stood in for, by a fetch that records what would have gone to
// the provider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIN = 60_000;
const SIGNED_UP = new Date("2026-12-01T09:00:00Z");
const at = (minutes: number) => new Date(SIGNED_UP.getTime() + minutes * MIN);

type Row = {
  userId: string;
  welcomeDueAt: Date | null;
  questionsDoneAt: Date | null;
  uses: string[];
};
type Send = { id: string; userId: string; campaign: string; sentAt: Date | null };

const db = vi.hoisted(() => ({
  users: [] as { id: string; email: string; name: string | null }[],
  onboarding: [] as Row[],
  sends: [] as Send[],
  nextId: 0,
}));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

vi.mock("@traceroot/core", async (importOriginal) => {
  const { Prisma } = await import("@prisma/client");
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) =>
      value === null ? row[key as keyof Row] === null : row[key as keyof Row] === value,
    );
  return {
    ...(await importOriginal<typeof import("@traceroot/core")>()),
    prisma: {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const user = db.users.find((u) => u.id === where.id);
          if (!user) return null;
          return { ...user, onboarding: db.onboarding.find((r) => r.userId === user.id) ?? null };
        },
      },
      userOnboarding: {
        createMany: async ({ data }: { data: Partial<Row>[] }) => {
          for (const row of data) {
            if (db.onboarding.some((r) => r.userId === row.userId)) continue;
            db.onboarding.push({
              userId: row.userId!,
              welcomeDueAt: row.welcomeDueAt ?? null,
              questionsDoneAt: null,
              uses: [],
            });
          }
          return { count: data.length };
        },
        updateMany: async ({ where, data }: { where: Partial<Row>; data: Partial<Row> }) => {
          const rows = db.onboarding.filter((r) => matches(r, where));
          rows.forEach((r) => Object.assign(r, data));
          return { count: rows.length };
        },
        findMany: async ({ where }: { where: { welcomeDueAt: { lte: Date; gt: Date } } }) =>
          db.onboarding
            .filter(
              (r) =>
                r.welcomeDueAt &&
                r.welcomeDueAt <= where.welcomeDueAt.lte &&
                r.welcomeDueAt > where.welcomeDueAt.gt &&
                !db.sends.some((s) => s.userId === r.userId && s.campaign === "welcome"),
            )
            .map((r) => ({ userId: r.userId })),
      },
      // The unique (user, campaign) index, as the claim relies on it.
      emailSend: {
        create: async ({ data }: { data: { userId: string; campaign: string } }) => {
          await tick();
          if (db.sends.some((s) => s.userId === data.userId && s.campaign === data.campaign)) {
            throw new Prisma.PrismaClientKnownRequestError("unique", {
              code: "P2002",
              clientVersion: "test",
            });
          }
          const id = `send_${++db.nextId}`;
          db.sends.push({ id, userId: data.userId, campaign: data.campaign, sentAt: null });
          return { id };
        },
        findUnique: async ({
          where,
        }: {
          where: { userId_campaign: { userId: string; campaign: string } };
        }) =>
          db.sends.find(
            (s) =>
              s.userId === where.userId_campaign.userId &&
              s.campaign === where.userId_campaign.campaign,
          ) ?? null,
        updateMany: async ({ where, data }: { where: { id: string }; data: { sentAt: Date } }) => {
          const send = db.sends.find((s) => s.id === where.id && !s.sentAt);
          if (send) send.sentAt = data.sentAt;
          return { count: send ? 1 : 0 };
        },
        deleteMany: async ({ where }: { where: { id: string } }) => {
          const before = db.sends.length;
          db.sends = db.sends.filter((s) => !(s.id === where.id && !s.sentAt));
          return { count: before - db.sends.length };
        },
      },
    },
  };
});

const deployment = vi.hoisted(() => ({ cloud: true, followUps: "off" }));
vi.mock("@/lib/server/cloud", () => ({ isCloud: () => deployment.cloud }));
vi.mock("@/lib/lifecycle/follow-up-job", () => ({ followUpMode: () => deployment.followUps }));
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example" } }));
vi.mock("@/env.client", () => ({
  clientEnv: {
    NEXT_PUBLIC_FOUNDERS_CAL_URL: "https://cal.example/30min",
    NEXT_PUBLIC_GITHUB_REPO_URL: "https://github.com/traceroot-ai/traceroot",
  },
}));
vi.mock("../demo-link", () => ({
  demoProjectUrl: async (appUrl: string) => `${appUrl}/demo`,
}));

import {
  runWelcomeFallback,
  scheduleWelcome,
  sendScheduledWelcome,
  WELCOME_FALLBACK_MS,
  welcomeVariant,
} from "./welcome-schedule";

/** What reached the provider, and a switch to make it fail. */
const provider = { emails: [] as Record<string, unknown>[], failing: false, contactFails: false };
const fetchImpl = (async (url: string, init: { method: string; body?: string }) => {
  await tick();
  const path = new URL(url).pathname;
  if (path.startsWith("/contacts")) {
    if (provider.contactFails) return new Response("{}", { status: 500 });
    return new Response("{}", { status: 200 });
  }
  if (path === "/emails" && init.method === "POST") {
    if (provider.failing) return new Response('{"message":"down"}', { status: 503 });
    provider.emails.push(JSON.parse(init.body!));
    return Response.json({ id: `email_${provider.emails.length}` });
  }
  return new Response("{}", { status: 404 });
}) as unknown as typeof fetch;

function signUp(id: string) {
  db.users.push({ id, email: `${id}@acme.test`, name: "Kai Lee" });
  return scheduleWelcome(id, SIGNED_UP);
}
function answer(id: string, uses: string[], doneAt = at(3)) {
  const row = db.onboarding.find((r) => r.userId === id)!;
  Object.assign(row, { uses, questionsDoneAt: doneAt });
}
const subjects = () => provider.emails.map((e) => e.subject);

beforeEach(() => {
  db.users = [];
  db.onboarding = [];
  db.sends = [];
  provider.emails = [];
  provider.failing = false;
  provider.contactFails = false;
  deployment.cloud = true;
  deployment.followUps = "off";
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("TRACEROOT_UPDATES_EMAIL_FROM", "Xinwei <x@updates.example>");
  vi.stubEnv("TRACEROOT_UPDATES_EMAIL_REPLY_TO", "team@example.test");
  vi.stubEnv("RESEND_PRODUCT_TOPIC_ID", "topic_product");
  vi.stubEnv("TRACEROOT_UNSUBSCRIBE_TOKEN_SECRET", "unsubscribe-secret-for-tests-0123456789");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("welcomeVariant", () => {
  it.each<[string, Date | null, string[], string]>([
    ["only just looking around", at(3), ["exploring"], "exploring"],
    ["looking around and something else", at(3), ["exploring", "rag"], "generic"],
    ["skipped the question", at(3), [], "generic"],
    ["a real use", at(3), ["coding_agents"], "generic"],
    ["never finished, even with an answer saved", null, ["exploring"], "generic"],
  ])("%s → %s", (_who, questionsDoneAt, uses, variant) => {
    expect(welcomeVariant({ questionsDoneAt, uses })).toBe(variant);
  });
});

describe("the welcome after the questions", () => {
  it("answering just looking around sends the look-around version", async () => {
    await signUp("u1");
    answer("u1", ["exploring"]);
    expect(await sendScheduledWelcome("u1", { fetchImpl })).toMatchObject({ status: "sent" });
    expect(subjects()).toEqual(["A trace you can explore"]);
    expect(provider.emails[0]).toMatchObject({ to: ["u1@acme.test"], topic_id: "topic_product" });
  });

  it("skipping the last question sends the standard version", async () => {
    await signUp("u1");
    answer("u1", []);
    await sendScheduledWelcome("u1", { fetchImpl });
    expect(subjects()).toEqual(["Send your first trace"]);
  });

  it("sends nothing to someone whose sign-up recorded no welcome", async () => {
    db.users.push({ id: "old", email: "old@acme.test", name: null });
    expect(await sendScheduledWelcome("old", { fetchImpl })).toEqual({ status: "not_scheduled" });
    expect(provider.emails).toHaveLength(0);
  });

  it("does not send without a contact, so the opt-out has a record; the run retries", async () => {
    await signUp("u1");
    provider.contactFails = true;
    expect(await sendScheduledWelcome("u1", { fetchImpl })).toEqual({ status: "no_contact" });
    expect(db.sends).toHaveLength(0);
  });
});

describe("the scheduled fallback", () => {
  it("records the due time 15 minutes after sign-up, once", async () => {
    await signUp("u1");
    await scheduleWelcome("u1", at(60));
    expect(db.onboarding[0].welcomeDueAt).toEqual(
      new Date(SIGNED_UP.getTime() + WELCOME_FALLBACK_MS),
    );
  });

  it("sends nothing before 15 minutes, and the standard version at 15", async () => {
    await signUp("u1");
    expect(await runWelcomeFallback({ now: at(14.99), fetchImpl })).toMatchObject({ due: 0 });
    expect(await runWelcomeFallback({ now: at(15), fetchImpl })).toMatchObject({ due: 1, sent: 1 });
    expect(subjects()).toEqual(["Send your first trace"]);
    // The next run finds it sent.
    expect(await runWelcomeFallback({ now: at(30), fetchImpl })).toMatchObject({ due: 0 });
    expect(provider.emails).toHaveLength(1);
  });

  it("someone who answered but whose send failed gets their version on the retry", async () => {
    await signUp("u1");
    answer("u1", ["exploring"]);
    provider.failing = true;
    expect(await sendScheduledWelcome("u1", { fetchImpl })).toMatchObject({ status: "failed" });
    expect(db.sends).toHaveLength(0);
    provider.failing = false;
    expect(await runWelcomeFallback({ now: at(15), fetchImpl })).toMatchObject({ sent: 1 });
    expect(subjects()).toEqual(["A trace you can explore"]);
  });

  it("stops retrying a day after it fell due", async () => {
    await signUp("u1");
    expect(await runWelcomeFallback({ now: at(15 + 24 * 60), fetchImpl })).toMatchObject({
      due: 0,
    });
  });

  it("runs whether or not the follow-ups are on", async () => {
    await signUp("u1");
    deployment.followUps = "off";
    expect(await runWelcomeFallback({ now: at(15), fetchImpl })).toMatchObject({ sent: 1 });
  });

  it("does nothing on a self-hosted install, or without product mail", async () => {
    await signUp("u1");
    deployment.cloud = false;
    expect(await runWelcomeFallback({ now: at(15), fetchImpl })).toMatchObject({ due: 0 });
    deployment.cloud = true;
    vi.stubEnv("RESEND_PRODUCT_TOPIC_ID", "");
    expect(await runWelcomeFallback({ now: at(15), fetchImpl })).toMatchObject({ due: 0 });
    expect(provider.emails).toHaveLength(0);
  });
});

describe("one welcome, however the sends race", () => {
  it("the questions ending and the run at 15 minutes, at once: one email", async () => {
    await signUp("u1");
    answer("u1", ["exploring"], at(14.9));
    const [fromQuestions, fromRun] = await Promise.all([
      sendScheduledWelcome("u1", { fetchImpl }),
      runWelcomeFallback({ now: at(15), fetchImpl }),
    ]);
    expect(provider.emails).toHaveLength(1);
    expect(db.sends.filter((s) => s.sentAt)).toHaveLength(1);
    expect([fromQuestions.status, fromRun.sent ? "sent" : "lost"]).toContain("sent");
  });

  it("two overlapping runs and a retried finish: one email", async () => {
    await signUp("u1");
    await Promise.all([
      runWelcomeFallback({ now: at(15), fetchImpl }),
      runWelcomeFallback({ now: at(15), fetchImpl }),
      sendScheduledWelcome("u1", { fetchImpl }),
      sendScheduledWelcome("u1", { fetchImpl }),
    ]);
    expect(provider.emails).toHaveLength(1);
  });

  it("a finish after the fallback sent sends nothing more", async () => {
    await signUp("u1");
    await runWelcomeFallback({ now: at(15), fetchImpl });
    answer("u1", ["exploring"], at(20));
    expect(await sendScheduledWelcome("u1", { fetchImpl })).toEqual({ status: "already-sent" });
    expect(subjects()).toEqual(["Send your first trace"]);
  });
});
