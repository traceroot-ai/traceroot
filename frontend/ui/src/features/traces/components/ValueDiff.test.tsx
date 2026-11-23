// @vitest-environment jsdom
/**
 * Two values compared line by line, as the hosts give them (`normalizeForDiff`): two
 * aligned columns or one inline diff, the changed words marked inside each changed line,
 * structured values compared as canonical JSON and decoded once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { normalizeForDiff } from "@/lib/eval/line-diff";
import { ValueDiff, type DiffLayout, type DiffSide } from "./ValueDiff";

afterEach(() => cleanup());

const side = (label: string, tag: string, raw: string): DiffSide => ({
  label,
  tag,
  text: normalizeForDiff(raw),
  missing: "No output",
});

function renderDiff(
  before: string,
  after: string,
  layout: DiffLayout = "columns",
  valueName?: string,
) {
  return render(
    <ValueDiff
      before={side("Baseline", "#1", before)}
      after={side("Candidate", "#2", after)}
      layout={layout}
      valueName={valueName}
    />,
  );
}

/** The text of each diff line of a kind, in order. */
const linesOf = (kind: "add" | "remove" | "context") =>
  [...document.querySelectorAll(`[data-line="${kind}"]`)].map(
    (el) => el.querySelector("[data-line-text]")?.textContent,
  );
/** The marked words of each kind, in order. */
const words = (kind: "add" | "remove") =>
  [...document.querySelectorAll(`[data-word="${kind}"]`)].map((el) => el.textContent);

// Same answer, keys in another order, one more step.
const SSO_BEFORE = JSON.stringify({ answer: "Open Settings", steps: ["Settings", "SSO"] });
const SSO_AFTER = JSON.stringify({ steps: ["Settings", "SSO", "Reset"], answer: "Open Settings" });

describe("ValueDiff", () => {
  it("lines the two values up side by side, marking only what changed", () => {
    renderDiff(SSO_BEFORE, SSO_AFTER);
    // Key order is not a change: the values are compared as canonical, indented JSON.
    expect(linesOf("context")).toContain('  "answer": "Open Settings",');
    expect(linesOf("remove")).toEqual(['    "SSO"']);
    expect(linesOf("add")).toEqual(['    "SSO",', '    "Reset"']);
  });

  it("shows the same change as one inline diff", () => {
    renderDiff(SSO_BEFORE, SSO_AFTER, "inline");
    const changed = [...document.querySelectorAll('[data-line="add"], [data-line="remove"]')];
    expect(changed.map((el) => el.textContent)).toEqual([
      '−    "SSO"',
      '+    "SSO",',
      '+    "Reset"',
    ]);
  });

  it("compares each value as decoded once, so genuine strings keep their text", () => {
    // Genuine strings, stored JSON-encoded, that read as the same number once decoded twice.
    renderDiff(JSON.stringify("1.50"), JSON.stringify("1.5"));
    expect(linesOf("remove")).toEqual(["1.50"]);
    expect(linesOf("add")).toEqual(["1.5"]);
  });

  it("finds no differences between objects whose keys are in another order", () => {
    renderDiff('{"a":1,"b":2}', '{"b":2,"a":1}');
    expect(screen.getByText("No differences.")).toBeTruthy();
    expect(linesOf("add")).toEqual([]);
    expect(linesOf("remove")).toEqual([]);
  });

  it("marks the words that changed inside a changed line, in both layouts", () => {
    renderDiff("full answer", "partial answer");
    expect(linesOf("remove")).toEqual(["full answer"]);
    expect(words("remove")).toEqual(["full"]);
    expect(words("add")).toEqual(["partial"]);
    cleanup();
    renderDiff("full answer", "partial answer", "inline");
    expect(words("remove")).toEqual(["full"]);
    expect(words("add")).toEqual(["partial"]);
    cleanup();
    // One more array item: only the comma it needs reads as new on the line before it.
    renderDiff(SSO_BEFORE, SSO_AFTER);
    expect(words("remove")).toEqual([]);
    expect(words("add")).toEqual([","]);
  });
});

describe("ValueDiff with a pair too large to align", () => {
  // 1,500 lines a side, none shared: past what the line alignment takes on.
  const many = (prefix: string) =>
    Array.from({ length: 1500 }, (_, i) => `${prefix} line ${i}`).join("\n");

  it("says so and shows each value whole, unmarked", () => {
    renderDiff(many("baseline"), many("candidate"));
    expect(screen.getByText("These outputs are too long to compare line by line.")).toBeTruthy();
    expect(linesOf("add")).toEqual([]);
    expect(linesOf("remove")).toEqual([]);
    expect(linesOf("context")).toHaveLength(3000);
    expect(linesOf("context")[1500]).toBe("candidate line 0");
  });

  it("names metadata values in plain words", () => {
    renderDiff(many("baseline"), many("candidate"), "inline", "metadata");
    expect(
      screen.getByText("These metadata values are too long to compare line by line."),
    ).toBeTruthy();
  });
});
