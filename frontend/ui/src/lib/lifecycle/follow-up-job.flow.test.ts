// The job against an in-memory stand-in for the tables it reads; sending is
// stood in for at sendOnce, so nothing leaves the test.
import { beforeEach, describe, expect, it, vi } from "vitest";

const DAY = 86_400_000;
const NOW = new Date("2026-12-10T12:00:00Z");
const START = "2026-12-01T00:00:00Z";
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

const db = vi.hoisted(() => ({
  users: [] as { id: string; email: string; name: string | null; createdAt: Date }[],
  onboarding: [] as {
    userId: string;
    followUpsPausedAt: Date | null;
    unsubscribedAt: Date | null;
  }[],
  sends: [] as { userId: string; campaign: string; sentAt: Date | null; claimedAt: Date }[],
  members: [] as { userId: string; workspaceId: string }[],
  workspaces: [] as { id: string; createdBy: string | null; createTime: Date }[],
  projects: [] as {
    id: string;
    workspaceId: string;
    firstTraceReceiveTime: Date | null;
    createTime: Date;
  }[],
  github: [] as { workspaceId: string }[],
  slack: [] as { workspaceId: string }[],
  evalRuns: [] as { projectId: string }[],
}));
const inList = (v: string, where?: { in?: string[] }) => !where?.in || where.in.includes(v);
vi.mock("@traceroot/core", async (importOriginal) => ({
  // The email layout constants are the real ones; only the database is stood in.
  ...(await importOriginal<typeof import("@traceroot/core")>()),
  prisma: {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.users.find((u) => u.id === where.id) ?? null,
      findMany: async ({ where }: { where: { createdAt: { gte: Date; lte: Date } } }) =>
        db.users
          .filter((u) => u.createdAt >= where.createdAt.gte && u.createdAt <= where.createdAt.lte)
          .sort((a, b) => +a.createdAt - +b.createdAt),
    },
    userOnboarding: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        db.onboarding.find((r) => r.userId === where.userId) ?? null,
    },
    emailSend: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        db.sends.filter((s) => s.userId === where.userId),
    },
    workspaceMember: {
      findMany: async ({ where }: { where: { userId: string } }) =>
        db.members
          .filter((m) => m.userId === where.userId)
          .map((m) => ({ workspace: db.workspaces.find((w) => w.id === m.workspaceId)! })),
    },
    project: {
      findMany: async ({ where }: { where: { workspaceId: { in: string[] } } }) =>
        db.projects.filter((p) => inList(p.workspaceId, where.workspaceId)),
      findFirst: async ({
        where,
      }: {
        where: { workspaceId?: string; workspace?: { members: { some: { userId: string } } } };
      }) => {
        const userId = where.workspace?.members.some.userId;
        const allowed = userId
          ? db.members
              .filter((m) => m.userId === userId && m.workspaceId !== "ws_demo")
              .map((m) => m.workspaceId)
          : [where.workspaceId!];
        return (
          [...db.projects]
            .sort((a, b) => +a.createTime - +b.createTime)
            .find((p) => allowed.includes(p.workspaceId)) ?? null
        );
      },
    },
    workspace: {
      findFirst: async ({ where }: { where: { createdBy: string } }) =>
        db.workspaces.find((w) => w.createdBy === where.createdBy && w.id !== "ws_demo") ?? null,
    },
    gitHubInstallation: {
      count: async ({ where }: { where: { workspaceId: { in: string[] } } }) =>
        db.github.filter((g) => inList(g.workspaceId, where.workspaceId)).length,
    },
    slackIntegration: {
      count: async ({ where }: { where: { workspaceId: { in: string[] } } }) =>
        db.slack.filter((s) => inList(s.workspaceId, where.workspaceId)).length,
    },
    evaluationRun: {
      count: async ({ where }: { where: { projectId: { in: string[] } } }) =>
        db.evalRuns.filter((r) => inList(r.projectId, where.projectId)).length,
    },
  },
}));

const mail = vi.hoisted(() => ({ sendOnce: vi.fn(), configured: true }));
vi.mock("@traceroot/core/email", () => ({
  isProductMailConfigured: () => mail.configured,
  resendConfig: () => ({ replyTo: "team@example.test" }),
  sendOnce: mail.sendOnce,
  signUnsubscribeToken: () => "tok",
  unsubscribeHeaders: () => ({ "List-Unsubscribe": "<x>" }),
  UNSUBSCRIBE_PATH: "/api/email/unsubscribe",
}));
vi.mock("@/lib/server/cloud", () => ({ isCloud: () => true }));
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://app.example" } }));
vi.mock("@/env.client", () => ({
  clientEnv: { NEXT_PUBLIC_FOUNDERS_CAL_URL: "https://cal.example/30min" },
}));
vi.mock("@/lib/demo-workspace", () => ({
  demoWorkspaceId: () => "ws_demo",
  userMembershipWhere: (userId: string) => ({ userId }),
}));

import { followUpFacts, runFollowUps } from "./follow-up-job";

function person(
  id: string,
  signedUpDaysAgo: number,
  opts: { trace?: number; invited?: boolean } = {},
) {
  const createdAt = ago(signedUpDaysAgo);
  db.users.push({ id, email: `${id}@acme.test`, name: `Kai ${id}`, createdAt });
  const ws = `ws_${id}`;
  db.workspaces.push({
    id: ws,
    createdBy: opts.invited ? "someone_else" : id,
    createTime: createdAt,
  });
  db.members.push({ userId: id, workspaceId: ws }, { userId: id, workspaceId: "ws_demo" });
  db.projects.push({
    id: `p_${id}`,
    workspaceId: ws,
    firstTraceReceiveTime: opts.trace !== undefined ? ago(opts.trace) : null,
    createTime: createdAt,
  });
  db.sends.push({ userId: id, campaign: "welcome", sentAt: createdAt, claimedAt: createdAt });
}

beforeEach(() => {
  for (const table of Object.values(db)) table.length = 0;
  db.workspaces.push({ id: "ws_demo", createdBy: null, createTime: ago(100) });
  db.projects.push({
    id: "p_demo",
    workspaceId: "ws_demo",
    firstTraceReceiveTime: ago(100),
    createTime: ago(100),
  });
  mail.configured = true;
  mail.sendOnce.mockReset().mockResolvedValue({ status: "sent", id: "m1" });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("the facts the decision reads", () => {
  it("come from the person's own workspaces, never the demo", async () => {
    person("u1", 9, { trace: 2 });
    db.projects.push({
      id: "p_u1_b",
      workspaceId: "ws_u1",
      firstTraceReceiveTime: ago(5),
      createTime: ago(8),
    });
    db.github.push({ workspaceId: "ws_u1" });
    db.slack.push({ workspaceId: "ws_demo" });
    db.evalRuns.push({ projectId: "p_demo" });
    db.onboarding.push({ userId: "u1", followUpsPausedAt: ago(1), unsubscribedAt: null });
    db.sends.push({ userId: "u1", campaign: "setup_help", sentAt: null, claimedAt: ago(0.5) });

    const facts = await followUpFacts("u1", NOW, new Date(START));
    expect(facts).toMatchObject({
      isCloud: true,
      signedUpAt: ago(9),
      firstTraceAt: ago(5),
      githubConnected: true,
      slackConnected: false,
      hasRunEval: false,
      paused: true,
      unsubscribed: false,
      invitedOnly: false,
    });
    // An email claimed and not yet sent counts from its claim.
    expect(facts?.sends).toContainEqual({ campaign: "setup_help", at: ago(0.5) });
  });

  it("count the welcome only once it was sent, and an unsent follow-up from its claim", async () => {
    person("u2", 3);
    // The welcome's claim, with no send recorded.
    db.sends.find((s) => s.userId === "u2" && s.campaign === "welcome")!.sentAt = null;
    db.sends.push({ userId: "u2", campaign: "last_note", sentAt: null, claimedAt: ago(0.5) });
    const facts = await followUpFacts("u2", NOW, new Date(START));
    expect(facts?.sends).toEqual([{ campaign: "last_note", at: ago(0.5) }]);
  });

  it("say invited-only for someone only in a colleague's workspace", async () => {
    person("u2", 3, { invited: true });
    expect((await followUpFacts("u2", NOW, new Date(START)))?.invitedOnly).toBe(true);
  });

  it("are null for an unknown user", async () => {
    expect(await followUpFacts("nobody", NOW, new Date(START))).toBeNull();
  });
});

describe("a run that sends", () => {
  const environment = { LIFECYCLE_EMAILS_ENABLED: "true", LIFECYCLE_START_AT: START };

  it("sends each due email once through sendOnce, with this person's links", async () => {
    person("due", 3);
    person("early", 1);
    person("traced", 9, { trace: 8 });
    const run = await runFollowUps({ environment, now: NOW });

    expect(run).toMatchObject({
      mode: "send",
      considered: 3,
      due: { setup_help: 1, connect_slack_github: 1 },
      sent: 2,
    });
    expect(run.notDue).toEqual({ nothing_due: 1 });
    const keys = mail.sendOnce.mock.calls.map(([, key]) => key);
    expect(keys).toEqual([
      { userId: "traced", campaign: "connect_slack_github", kind: "product" },
      { userId: "due", campaign: "setup_help", kind: "product" },
    ]);

    const build = mail.sendOnce.mock.calls[1][2] as () => {
      to: string;
      text: string;
      idempotencyKey: string;
      tags: Record<string, string>;
    };
    const email = build();
    expect(email.to).toBe("due@acme.test");
    expect(email.idempotencyKey).toBe("setup_help/due");
    expect(email.tags).toEqual({ category: "product", template: "setup_help" });
    expect(email.text).toContain("Open setup: https://app.example/projects/p_due/traces");
    expect(email.text).toContain("Pick a time (https://cal.example/30min)");

    const connect = (mail.sendOnce.mock.calls[0][2] as () => { text: string })();
    expect(connect.text).toContain(
      "https://app.example/workspaces/ws_traced/settings/integrations",
    );
  });

  it("sends Setup help on day 3 only to someone whose welcome was sent", async () => {
    person("sent", 3);
    person("claimed", 3);
    db.sends.find((s) => s.userId === "claimed" && s.campaign === "welcome")!.sentAt = null;
    mail.sendOnce.mockResolvedValue({ status: "sent", id: "e1" });
    const run = await runFollowUps({ now: NOW, environment });
    expect(run.due).toEqual({ setup_help: 1 });
    expect(run.notDue).toMatchObject({ no_welcome: 1 });
    expect(mail.sendOnce).toHaveBeenCalledTimes(1);
    expect(mail.sendOnce.mock.calls[0][1]).toMatchObject({
      userId: "sent",
      campaign: "setup_help",
    });
  });

  it("counts sends that failed or were already claimed elsewhere", async () => {
    person("a", 3);
    person("b", 3);
    mail.sendOnce
      .mockResolvedValueOnce({ status: "failed", error: "x" })
      .mockResolvedValueOnce({ status: "in-flight" });
    const run = await runFollowUps({ environment, now: NOW });
    expect(run).toMatchObject({ sent: 0, failed: 1, skipped: 1 });
  });

  it("links the demo project for Last note", async () => {
    person("late", 7);
    db.sends.push({ userId: "late", campaign: "setup_help", sentAt: ago(4), claimedAt: ago(4) });
    await runFollowUps({ environment, now: NOW });
    const email = (mail.sendOnce.mock.calls[0][2] as () => { text: string })();
    expect(email.text).toContain(
      "Open the demo project: https://app.example/projects/p_demo/traces",
    );
  });

  it("does not send while product mail is not configured", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mail.configured = false;
    person("due", 3);
    expect((await runFollowUps({ environment, now: NOW })).considered).toBe(0);
    expect(mail.sendOnce).not.toHaveBeenCalled();
  });
});

describe("a dry run", () => {
  it("counts what is due, logs the user id and email name only, and sends nothing", async () => {
    person("due", 3);
    const run = await runFollowUps({
      environment: { LIFECYCLE_EMAILS_DRY_RUN: "true", LIFECYCLE_START_AT: START },
      now: NOW,
    });
    expect(run).toMatchObject({ mode: "dry_run", due: { setup_help: 1 }, sent: 0 });
    expect(mail.sendOnce).not.toHaveBeenCalled();
    const logged = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(logged).toContain("user due is due setup_help");
    expect(logged).not.toContain("@acme.test");
  });
});
