import { describe, it, expect } from "vitest";
import { matchSpans, type MatchSpan } from "./span-match";

const s = (
  span_id: string,
  parent_span_id: string | null,
  name: string,
  span_kind: string,
): MatchSpan => ({ span_id, parent_span_id, name, span_kind });

describe("matchSpans", () => {
  it("matches the eval shape structurally despite different ids", () => {
    // Candidate: root → task → llm; root → scorer_a, scorer_b
    const cand = [
      s("c_root", null, "evaluation-item", "EVALUATION"),
      s("c_task", "c_root", "task", "TASK"),
      s("c_llm", "c_task", "anthropic.messages", "LLM"),
      s("c_sa", "c_root", "routing_accuracy", "SCORER"),
      s("c_sb", "c_root", "routing_report", "SCORER"),
    ];
    // Baseline: same structure, different ids and a different LLM model name is fine
    // (LLM span name here is the same); scorers in a different order.
    const base = [
      s("b_root", null, "evaluation-item", "EVALUATION"),
      s("b_sb", "b_root", "routing_report", "SCORER"),
      s("b_task", "b_root", "task", "TASK"),
      s("b_llm", "b_task", "anthropic.messages", "LLM"),
      s("b_sa", "b_root", "routing_accuracy", "SCORER"),
    ];
    const m = matchSpans(cand, base);
    expect(m.get("c_root")?.span_id).toBe("b_root");
    expect(m.get("c_task")?.span_id).toBe("b_task");
    expect(m.get("c_llm")?.span_id).toBe("b_llm");
    expect(m.get("c_sa")?.span_id).toBe("b_sa"); // matched by name, not order
    expect(m.get("c_sb")?.span_id).toBe("b_sb");
  });

  it("pairs repeated same-key siblings in order", () => {
    const cand = [
      s("c_root", null, "root", "AGENT"),
      s("c_t1", "c_root", "tool", "TOOL"),
      s("c_t2", "c_root", "tool", "TOOL"),
    ];
    const base = [
      s("b_root", null, "root", "AGENT"),
      s("b_t1", "b_root", "tool", "TOOL"),
      s("b_t2", "b_root", "tool", "TOOL"),
    ];
    const m = matchSpans(cand, base);
    expect(m.get("c_t1")?.span_id).toBe("b_t1");
    expect(m.get("c_t2")?.span_id).toBe("b_t2");
  });

  it("leaves an unmatched candidate span absent", () => {
    const cand = [
      s("c_root", null, "root", "AGENT"),
      s("c_extra", "c_root", "only-in-candidate", "TOOL"),
    ];
    const base = [s("b_root", null, "root", "AGENT")];
    const m = matchSpans(cand, base);
    expect(m.get("c_root")?.span_id).toBe("b_root");
    expect(m.has("c_extra")).toBe(false);
  });

  it("returns empty when either side is empty", () => {
    expect(matchSpans([], [s("b", null, "x", "SPAN")]).size).toBe(0);
    expect(matchSpans([s("c", null, "x", "SPAN")], []).size).toBe(0);
  });
});
