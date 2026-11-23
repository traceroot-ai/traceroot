import { describe, expect, it } from "vitest";
import { dataFields, embeddingText, hitMaterial } from "../material.js";
import { cosine, shortlist } from "../shortlist.js";
import { groupSignalText, jevGroupKey, UNCLEAR_GROUP } from "../jev-group.js";
import {
  assignUserText,
  candidatesText,
  jevAssignQuestion,
  jevValidateQuestions,
  validateUserText,
  writerUserText,
} from "../prompts.js";
import type { Candidate } from "../types.js";

describe("dataFields", () => {
  it("keeps an object, parses a JSON object string, wraps anything else", () => {
    expect(dataFields({ tool: "search" })).toEqual({ tool: "search" });
    expect(dataFields('{"tool":"search"}')).toEqual({ tool: "search" });
    expect(dataFields("[1,2]")).toEqual({ value: [1, 2] });
    expect(dataFields("tool timed out")).toEqual({ value: "tool timed out" });
    expect(dataFields("  ")).toEqual({});
    expect(dataFields(null)).toEqual({});
    expect(dataFields([1])).toEqual({});
  });
});

describe("hit material", () => {
  it("formats detector, summary and data the way the benchmark did", () => {
    expect(hitMaterial("Failure", "The tool timed out.", { tool: "search", attempts: 3 })).toBe(
      "detector: Failure\nsummary: The tool timed out.\ndata: tool=search, attempts=3",
    );
    expect(hitMaterial("Failure", "s", {})).toBe("detector: Failure\nsummary: s\ndata: none");
    expect(embeddingText("The tool timed out.", { tool: "search" })).toBe(
      "The tool timed out.\ntool=search",
    );
  });

  it("serialises nested values and caps the length", () => {
    expect(hitMaterial("D", "s", { spans: ["a", "b"] })).toContain('spans=["a","b"]');
    expect(hitMaterial("D", "x".repeat(10_000), {}).length).toBe(4_000);
    expect(embeddingText("x".repeat(10_000), {}).length).toBe(4_000);
  });
});

describe("shortlist", () => {
  it("computes cosine and guards degenerate vectors", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
  });

  it("keeps the k nearest, nearest first, ties in input order", () => {
    const signals = [
      { id: "far", anchorEmbedding: [0, 1] },
      { id: "near", anchorEmbedding: [1, 0.1] },
      { id: "tieA", anchorEmbedding: [1, 1] },
      { id: "tieB", anchorEmbedding: [1, 1] },
      { id: "empty", anchorEmbedding: [] },
    ];
    expect(shortlist([1, 0], signals, 3).map((s) => s.id)).toEqual(["near", "tieA", "tieB"]);
    expect(shortlist([1, 0], signals, 10)).toHaveLength(5);
    expect(shortlist([1, 0], [], 10)).toEqual([]);
  });
});

describe("Jev-path grouping", () => {
  it("recognises a Jev judgment by its data and groups it by category", () => {
    const jev = { probabilities: { fabrication: 0.8, none: 0.2 }, confidence: 0.8, gate: 0.9 };
    expect(jevGroupKey({ ...jev, category: "fabrication" })).toBe("fabrication");
    expect(jevGroupKey({ ...jev, category: null })).toBe(UNCLEAR_GROUP);
  });

  it("leaves chat-path data alone", () => {
    expect(jevGroupKey({ category: "tool error" })).toBe(null);
    expect(jevGroupKey({ category: "x", probabilities: [], confidence: 1, gate: 1 })).toBe(null);
    expect(jevGroupKey({ category: "x", probabilities: {}, confidence: "high", gate: 1 })).toBe(
      null,
    );
    expect(jevGroupKey("plain text")).toBe(null);
    expect(jevGroupKey(null)).toBe(null);
  });

  it("writes fixed titles and criteria", () => {
    expect(groupSignalText("tool_misuse").title).toBe("Tool misuse");
    expect(groupSignalText("other").title).toBe("Unlisted problem");
    expect(groupSignalText(UNCLEAR_GROUP).title).toBe("Problem with no clear category");
    expect(groupSignalText("tool_misuse").covers).toContain('"tool_misuse" category');
  });
});

describe("prompts", () => {
  const cand: Candidate = {
    label: "s1",
    signalId: "sig",
    title: "Tool timeout ignored",
    covers: "The agent continues as if a timed-out tool succeeded.",
    excludes: "Tool errors reported to the user.",
    example: "e".repeat(1_000),
    status: "resolved",
    hitCount: 7,
    criteriaVersion: 2,
  };

  it("lists candidates with criteria, status, count and a bounded example", () => {
    const text = candidatesText([cand]);
    expect(text).toContain("[s1] Tool timeout ignored (status=resolved, hits=7)");
    expect(text).toContain("covers: The agent continues");
    expect(text).toContain("excludes: Tool errors");
    expect(text).toContain(`example: ${"e".repeat(600)}`);
    expect(text).not.toContain("e".repeat(601));
    expect(candidatesText([])).toContain("no signals yet");
  });

  it("builds the user texts", () => {
    expect(assignUserText("M", [cand])).toMatch(/^HIT:\nM\n\nCANDIDATE SIGNALS:\n\[s1]/);
    expect(writerUserText("M", [])).toContain("none of them covers the hit");
    const v = validateUserText("C", "E", ["a", "b"]);
    expect(v).toContain("covers: C\nexcludes: E");
    expect(v).toContain("HIT 0:\na\n\nHIT 1:\nb");
  });

  it("builds Jev questions with a none option and one yes/no per text", () => {
    const q = jevAssignQuestion([cand]);
    expect(Object.keys(q.signal.criteria)).toEqual(["s1", "none"]);
    expect(q.signal.criteria.s1.what).toContain(`Example hit: ${"e".repeat(400)}`);
    expect(q.signal.criteria.s1.what).not.toContain("e".repeat(401));
    expect(q.signal.criteria.s1.not_for).toBe(cand.excludes);
    expect(Object.keys(jevValidateQuestions(3))).toEqual(["hit_0", "hit_1", "hit_2"]);
  });
});
