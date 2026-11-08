import { describe, expect, it, vi } from "vitest";
import { assignIncrementally, nearestGroups, type Item, type Judge } from "../incremental.js";

const item = (id: string, t: number, embedding: number[]): Item => ({
  traceId: id,
  traceTimeMs: t,
  summary: `summary ${id}`,
  embedding,
});

/** Joins the candidate whose example text names the same axis, else says none. */
function fakeJudge(): Judge & {
  chooses: ReturnType<typeof vi.fn>;
  describes: ReturnType<typeof vi.fn>;
} {
  const chooses = vi.fn();
  const describes = vi.fn();
  return {
    chooses,
    describes,
    async choose(summary, candidates) {
      chooses(summary, candidates);
      const axis = summary.includes("alpha") ? "alpha" : "beta";
      return candidates.find((c) => c.example.includes(axis))?.label ?? "none";
    },
    async describe(summary, candidates) {
      describes(summary, candidates);
      return { title: `Group of ${summary}`, covers: "things like it" };
    },
  };
}

describe("assignIncrementally", () => {
  const items = [
    item("x1", 1, [1, 0]),
    item("y1", 2, [0, 1]),
    item("x2", 3, [0.9, 0.1]),
    item("y2", 4, [0.1, 0.9]),
  ];

  it("starts a group for the first summary without asking the judge to choose", async () => {
    const judge = fakeJudge();
    const result = await assignIncrementally(items.slice(0, 1), judge);
    expect(result.chooseCalls).toBe(0);
    expect(result.describeCalls).toBe(1);
    expect(result.groups).toHaveLength(1);
  });

  it("joins the group the judge picks and starts a new one on none", async () => {
    const judge = fakeJudge();
    // The fake looks for the letter x or y in the example text; give the summaries one.
    const withAxis = items.map((i) => ({
      ...i,
      summary: `${i.traceId.startsWith("x") ? "alpha" : "beta"} ${i.summary}`,
    }));
    const result = await assignIncrementally(withAxis, judge);
    expect(result.groups).toHaveLength(2);
    expect(result.assignments.x1).toBe(result.assignments.x2);
    expect(result.assignments.y1).toBe(result.assignments.y2);
    expect(result.assignments.x1).not.toBe(result.assignments.y1);
    expect(result.chooseCalls).toBe(3);
    expect(result.describeCalls).toBe(2);
  });

  it("offers at most k nearest groups, nearest first", async () => {
    const judge = fakeJudge();
    judge.choose = async () => "none";
    const many = Array.from({ length: 6 }, (_, i) => item(`t${i}`, i, [1, i]));
    const seen: number[] = [];
    judge.describe = async (_s, candidates) => {
      seen.push(candidates.length);
      return { title: "t", covers: "c" };
    };
    await assignIncrementally(many, judge, 3);
    expect(Math.max(...seen)).toBe(3);
  });

  it("treats an unknown answer as none", async () => {
    const judge = fakeJudge();
    judge.choose = async () => "ZZ";
    const result = await assignIncrementally(items.slice(0, 2), judge);
    expect(result.groups).toHaveLength(2);
  });

  it("is order dependent: the first summary of a group fixes where later ones go", async () => {
    const judge = fakeJudge();
    const result = await assignIncrementally([...items].reverse(), judge);
    expect(result.groups[0].exampleSummary).toBe("summary y2");
  });
});

describe("nearestGroups", () => {
  it("keeps creation order on ties", () => {
    const g = (id: string) => ({
      id,
      title: id,
      covers: "",
      exampleSummary: "",
      exampleEmbedding: [1, 0],
      size: 1,
    });
    expect(nearestGroups([1, 0], [g("a"), g("b")], 2).map((x) => x.id)).toEqual(["a", "b"]);
  });
});
