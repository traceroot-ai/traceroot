import { describe, it, expect } from "vitest";
import { diffLinesDetailed, lcsAlign, normalizeForDiff, sideBySide } from "./line-diff";

const diff = (before: string, after: string) => diffLinesDetailed(before, after).lines;
/** Two stored values as the comparison view diffs them: each normalized once, then diffed. */
const diffValues = (before: string, after: string) =>
  diff(normalizeForDiff(before), normalizeForDiff(after));

describe("diffLinesDetailed", () => {
  it("marks changed lines add/remove and keeps unchanged as context", () => {
    expect(diff("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  it("handles pure additions and removals", () => {
    expect(diff("a", "a\nb")).toEqual([
      { type: "context", text: "a" },
      { type: "add", text: "b" },
    ]);
    expect(diff("a\nb", "a")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
    ]);
  });

  it("treats Windows line endings like Unix ones", () => {
    expect(diff("a\r\nb", "a\nb").every((l) => l.type === "context")).toBe(true);
  });

  it("compares the text it is given, without decoding it again", () => {
    expect(diff("1.50", "1.5")).toEqual([
      { type: "remove", text: "1.50" },
      { type: "add", text: "1.5" },
    ]);
    expect(diff('"quoted"', "quoted")).toEqual([
      { type: "remove", text: '"quoted"' },
      { type: "add", text: "quoted" },
    ]);
  });

  it("falls back to a whole-value replace when the outputs are too large to align", () => {
    const a = Array.from({ length: 1500 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 1500 }, (_, i) => `b${i}`).join("\n");
    const { lines, truncated } = diffLinesDetailed(a, b);
    expect(truncated).toBe(true);
    expect(lines.slice(0, 1500).every((l) => l.type === "remove")).toBe(true);
    expect(lines.slice(1500).every((l) => l.type === "add")).toBe(true);
    // Identical large values still read as unchanged.
    expect(diffLinesDetailed(a, a)).toEqual({
      lines: a.split("\n").map((text) => ({ type: "context", text })),
      truncated: false,
    });
  });
});

describe("normalized values, diffed", () => {
  it("pretty-prints JSON so a structured value diffs line by line", () => {
    expect(diffValues('{"route":"billing","id":1}', '{"id":1,"route":"technical"}')).toEqual([
      { type: "context", text: "{" },
      { type: "context", text: '  "id": 1,' },
      { type: "remove", text: '  "route": "billing"' },
      { type: "add", text: '  "route": "technical"' },
      { type: "context", text: "}" },
    ]);
  });

  it("does not diff two objects that differ only in key order or spacing", () => {
    const d = diffValues('{"a":1,"b":{"y":2,"x":1}}', '{\n  "b": {"x": 1, "y": 2},\n  "a": 1\n}');
    expect(d.every((l) => l.type === "context")).toBe(true);
  });

  it("does not diff a double-encoded JSON string against the raw object", () => {
    const raw = '{"a":1,"b":2}';
    expect(diffValues(JSON.stringify(raw), raw).every((l) => l.type === "context")).toBe(true);
  });

  it("reads a JSON-encoded string as its text, so stored and plain text agree", () => {
    expect(diffValues(JSON.stringify("line one\nline two"), "line one\nline two")).toEqual([
      { type: "context", text: "line one" },
      { type: "context", text: "line two" },
    ]);
  });

  it("keeps genuine strings that look like numbers or quotes apart", () => {
    expect(diffValues(JSON.stringify("1.50"), JSON.stringify("1.5"))).toEqual([
      { type: "remove", text: "1.50" },
      { type: "add", text: "1.5" },
    ]);
    expect(diffValues(JSON.stringify('"quoted"'), JSON.stringify("quoted"))).toEqual([
      { type: "remove", text: '"quoted"' },
      { type: "add", text: "quoted" },
    ]);
  });
});

describe("normalizeForDiff", () => {
  it("leaves text that isn't JSON alone", () => {
    expect(normalizeForDiff("just text")).toBe("just text");
    expect(normalizeForDiff('{"bad": ')).toBe('{"bad": ');
    expect(normalizeForDiff("68°F")).toBe("68°F");
  });

  it("canonicalizes key order and indents two spaces", () => {
    expect(normalizeForDiff('{"b":2,"a":1}')).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it("preserves array order while sorting object keys", () => {
    expect(normalizeForDiff('[{"b":2,"a":1},3,2,1]')).toBe(
      '[\n  {\n    "a": 1,\n    "b": 2\n  },\n  3,\n  2,\n  1\n]',
    );
  });

  it("shows a JSON-encoded string as its text and other scalars as JSON", () => {
    expect(normalizeForDiff('"hello"')).toBe("hello");
    expect(normalizeForDiff(JSON.stringify("1.50"))).toBe("1.50");
    expect(normalizeForDiff("42")).toBe("42");
    expect(normalizeForDiff("null")).toBe("null");
  });
});

describe("sideBySide", () => {
  it("pairs each changed run's removed and added lines row by row", () => {
    expect(sideBySide(diff("a\nb\nc\nd", "a\nB\nc\nD\nE"))).toEqual([
      { left: { type: "context", text: "a" }, right: { type: "context", text: "a" } },
      { left: { type: "remove", text: "b" }, right: { type: "add", text: "B" } },
      { left: { type: "context", text: "c" }, right: { type: "context", text: "c" } },
      { left: { type: "remove", text: "d" }, right: { type: "add", text: "D" } },
      { left: null, right: { type: "add", text: "E" } },
    ]);
  });

  it("leaves the other side empty for a pure removal", () => {
    expect(sideBySide(diff("a\nb", "a"))).toEqual([
      { left: { type: "context", text: "a" }, right: { type: "context", text: "a" } },
      { left: { type: "remove", text: "b" }, right: null },
    ]);
  });
});

describe("lcsAlign", () => {
  it("pairs repeated elements from the front", () => {
    expect(lcsAlign(["s", "s"], ["s", "s", "s"], 100)).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(lcsAlign(["l", "t", "l", "t", "l"], ["l", "t", "l"], 100)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("skips what only one side has", () => {
    expect(lcsAlign(["a", "x", "b"], ["a", "b", "y"], 100)).toEqual([
      [0, 0],
      [2, 1],
    ]);
    expect(lcsAlign([], ["a"], 100)).toEqual([]);
  });

  it("gives up past its size limit", () => {
    expect(lcsAlign(["a", "b"], ["a", "b"], 3)).toBeNull();
  });
});
