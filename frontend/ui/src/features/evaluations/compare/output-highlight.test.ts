import { describe, expect, it } from "vitest";
import { changedWords } from "./output-highlight";

const marked = (segments: ReturnType<typeof changedWords>) =>
  segments?.filter((s) => s.changed).map((s) => s.text.trim()) ?? null;

describe("changedWords", () => {
  it("marks the words of an output that differ from the reference's", () => {
    const segments = changedWords(
      "Refunds are available within 30 days.",
      "Refunds are available within 14 days.",
    );
    expect(segments?.map((s) => s.text).join("")).toBe("Refunds are available within 30 days.");
    expect(marked(segments)).toEqual(["30"]);
  });

  it("marks the output as it is shown, trimmed", () => {
    const segments = changedWords("  Escalate to billing.\n", "Escalate to support.");
    expect(segments?.map((s) => s.text).join("")).toBe("Escalate to billing.");
    expect(marked(segments)).toEqual(["billing"]);
  });

  it("marks the whole output when it shares no word with the reference", () => {
    expect(changedWords("account_management", "billing")).toEqual([
      { text: "account_management", changed: true },
    ]);
    expect(changedWords("billing", "")).toEqual([{ text: "billing", changed: true }]);
  });

  it("marks nothing when the two read the same, a reformat included", () => {
    expect(changedWords("Same answer.", "Same answer.")).toBeNull();
    expect(changedWords('{"b": 1, "a": 2}', '{"a":2,"b":1}')).toBeNull();
  });

  it("marks nothing without a reference or an output", () => {
    expect(changedWords("An answer.", null)).toBeNull();
    expect(changedWords("An answer.", undefined)).toBeNull();
    expect(changedWords("   ", "An answer.")).toBeNull();
  });
});
