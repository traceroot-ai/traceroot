import { describe, it, expect } from "vitest";
import { diffLines, valuesDiffer, normalizeForDiff } from "./line-diff";

describe("diffLines", () => {
  it("marks changed lines add/remove and keeps unchanged as context", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc");
    expect(d).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "B" },
      { type: "context", text: "c" },
    ]);
  });

  it("handles pure additions and removals", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { type: "context", text: "a" },
      { type: "add", text: "b" },
    ]);
    expect(diffLines("a\nb", "a")).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
    ]);
  });

  it("pretty-prints JSON so a structured value diffs line by line", () => {
    const d = diffLines('{"route":"billing"}', '{"route":"technical"}');
    // Both pretty-print to 3 lines; only the middle line differs.
    expect(d.filter((l) => l.type === "context").map((l) => l.text)).toEqual(["{", "}"]);
    expect(d.find((l) => l.type === "remove")?.text).toContain("billing");
    expect(d.find((l) => l.type === "add")?.text).toContain("technical");
  });
});

describe("valuesDiffer", () => {
  it("ignores a pure JSON reformat", () => {
    expect(valuesDiffer('{"a":1}', '{\n  "a": 1\n}')).toBe(false);
    expect(valuesDiffer('{"a":1}', '{"a":2}')).toBe(true);
    expect(valuesDiffer("same", "same")).toBe(false);
  });
});

describe("normalizeForDiff", () => {
  it("leaves non-JSON text alone", () => {
    expect(normalizeForDiff("just text")).toBe("just text");
    expect(normalizeForDiff('{"bad": ')).toBe('{"bad": ');
  });
});
