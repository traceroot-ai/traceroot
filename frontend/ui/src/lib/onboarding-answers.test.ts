import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory `user_onboarding`, with the calls this module makes and the one
// constraint that matters to it: one row per user.
type Row = {
  userId: string;
  role: string | null;
  companyInput: string | null;
  companyDomain: string | null;
  uses: string[];
  source: string | null;
  sourceOther: string | null;
  questionsDoneAt: Date | null;
};
const db = vi.hoisted(() => ({ rows: [] as Row[] }));
vi.mock("@traceroot/core", () => {
  const find = (userId: string) => db.rows.find((row) => row.userId === userId);
  return {
    prisma: {
      userOnboarding: {
        findUnique: async ({ where }: { where: { userId: string } }) => find(where.userId) ?? null,
        createMany: async ({ data }: { data: { userId: string }[] }) => {
          let count = 0;
          for (const { userId } of data) {
            if (find(userId)) continue;
            db.rows.push({
              userId,
              role: null,
              companyInput: null,
              companyDomain: null,
              uses: [],
              source: null,
              sourceOther: null,
              questionsDoneAt: null,
            });
            count += 1;
          }
          return { count };
        },
        update: async ({ where, data }: { where: { userId: string }; data: Partial<Row> }) => {
          const row = find(where.userId);
          if (!row) throw new Error("P2025");
          return Object.assign(row, data);
        },
        updateMany: async ({
          where,
          data,
        }: {
          where: { userId: string; questionsDoneAt: null };
          data: Partial<Row>;
        }) => {
          const row = find(where.userId);
          if (!row || row.questionsDoneAt !== null) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      },
    },
  };
});
const analytics = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({ captureServerEvent: analytics.capture }));

import {
  ANSWERS_SUBMITTED_EVENT,
  finishOnboardingQuestions,
  readOnboardingAnswers,
  saveOnboardingAnswers,
} from "./onboarding-answers";
import { answersPatchSchema } from "./onboarding-questions";

beforeEach(() => {
  db.rows = [];
  analytics.capture.mockReset();
});

describe("saving answers as they are given", () => {
  it("keeps each answer, and the domain read from the company answer", async () => {
    await saveOnboardingAnswers("u1", { role: "founder" });
    await saveOnboardingAnswers("u1", { company: "https://www.acme.com/" });
    await saveOnboardingAnswers("u1", { uses: ["rag", "rag", "coding_agents"] });

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      role: "founder",
      companyInput: "https://www.acme.com/",
      companyDomain: "acme.com",
      uses: ["rag", "coding_agents"],
    });
    expect(analytics.capture).not.toHaveBeenCalled();
  });

  it("keeps a company given only by name, with no domain", async () => {
    await saveOnboardingAnswers("u1", { company: "Acme" });
    expect(db.rows[0]).toMatchObject({ companyInput: "Acme", companyDomain: null });
  });

  it("clears an answer that is skipped on the way back", async () => {
    await saveOnboardingAnswers("u1", { role: "data", company: "acme.com" });
    await saveOnboardingAnswers("u1", { role: null, company: "" });
    expect(db.rows[0]).toMatchObject({ role: null, companyInput: null, companyDomain: null });
  });

  it("survives two first saves at once", async () => {
    await Promise.all([
      saveOnboardingAnswers("u1", { role: "data" }),
      saveOnboardingAnswers("u1", { uses: ["rag"] }),
    ]);
    expect(db.rows).toHaveLength(1);
  });
});

describe("the answers a page reads back", () => {
  it("say whether the company question is asked, by the sign-up address", async () => {
    expect((await readOnboardingAnswers("u1", "kai@gmail.com")).companyAsked).toBe(true);
    expect((await readOnboardingAnswers("u1", "kai@acme.com")).companyAsked).toBe(false);
  });

  it("start empty and not done", async () => {
    expect(await readOnboardingAnswers("u1", "kai@acme.com")).toEqual({
      role: null,
      company: null,
      uses: [],
      source: null,
      sourceOther: null,
      companyAsked: false,
      done: false,
    });
  });
});

describe("finishing", () => {
  it("sends the event once, with ids and the domain only", async () => {
    await saveOnboardingAnswers("u1", {
      role: "engineering",
      company: "acme.io",
      uses: ["autonomous_agents"],
      source: "github",
      sourceOther: "a meetup in Berlin",
    });
    expect(await finishOnboardingQuestions("u1", "kai@gmail.com")).toEqual({ finished: true });
    expect(await finishOnboardingQuestions("u1", "kai@gmail.com")).toEqual({ finished: false });

    expect(analytics.capture).toHaveBeenCalledOnce();
    const [distinctId, event, properties] = analytics.capture.mock.calls[0];
    expect(distinctId).toBe("u1");
    expect(event).toBe(ANSWERS_SUBMITTED_EVENT);
    expect(properties).toEqual({
      role: "engineering",
      company_asked: true,
      company_domain: "acme.io",
      uses: ["autonomous_agents"],
      source: "github",
    });
    expect(JSON.stringify(properties)).not.toContain("Berlin");
    expect((await readOnboardingAnswers("u1", "kai@gmail.com")).done).toBe(true);
  });

  it("counts typed text alone as a source of other", async () => {
    await saveOnboardingAnswers("u1", { sourceOther: "a podcast" });
    await finishOnboardingQuestions("u1", "kai@acme.com");
    expect(analytics.capture.mock.calls[0][2]).toMatchObject({ source: "other" });
  });

  it("sends empty answers for someone who skipped everything", async () => {
    await finishOnboardingQuestions("u1", "kai@acme.com");
    expect(analytics.capture.mock.calls[0][2]).toEqual({
      role: null,
      company_asked: false,
      company_domain: null,
      uses: [],
      source: null,
    });
  });

  it("sends once when two finishes race", async () => {
    await Promise.all([
      finishOnboardingQuestions("u1", "kai@acme.com"),
      finishOnboardingQuestions("u1", "kai@acme.com"),
    ]);
    expect(analytics.capture).toHaveBeenCalledOnce();
  });
});

describe("what a save accepts", () => {
  it.each([
    [{ role: "founder" }, true],
    [{ role: "ceo" }, false],
    [{ uses: ["rag", "exploring", "other"] }, true],
    [{ uses: ["rag", "exploring", "other", "coding_agents"] }, false],
    [{ source: "other", sourceOther: "a talk" }, true],
    [{ source: "tiktok" }, false],
    [{ company: "x".repeat(201) }, false],
    [{ questionsDoneAt: "2026-01-01" }, false],
  ])("%j → %s", (patch, ok) => {
    expect(answersPatchSchema.safeParse(patch).success).toBe(ok);
  });
});
