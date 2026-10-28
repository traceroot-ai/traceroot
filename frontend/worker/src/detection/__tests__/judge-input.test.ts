import { describe, expect, it } from "vitest";
import { buildJudgeInput, sampleLines } from "../judge-input.js";

const row = (fields: Record<string, unknown>) =>
  JSON.stringify({
    trace_id: "t1",
    project_id: "p1",
    span_start_time: "2026-10-20T09:14:02.100000",
    span_end_time: "2026-10-20T09:14:03.350000",
    status: "OK",
    status_message: null,
    model_name: null,
    input_tokens: 61,
    total_tokens: 79,
    cost: null,
    ch_create_time: "2026-10-20T09:14:04",
    metadata: "{}",
    ...fields,
  });

const filler = (label: string, chars: number) => {
  let out = "";
  for (let i = 1; out.length < chars; i++) out += `${label} ${i}.\n`;
  return out;
};

describe("buildJudgeInput", () => {
  it("renders spans as text with numbers, parents and no internal columns", () => {
    const jsonl = [
      row({
        span_id: "a1",
        parent_span_id: null,
        name: "agent",
        span_kind: "AGENT",
        input: '"hi"',
        output: '"done"',
      }),
      row({
        span_id: "l1",
        parent_span_id: "a1",
        name: "chat",
        span_kind: "LLM",
        model_name: "gpt-x",
        input: JSON.stringify([
          { role: "system", content: "Be brief." },
          { role: "user", content: "hi" },
        ]),
        output: JSON.stringify({
          role: "assistant",
          content: null,
          tool_calls: [{ function: { name: "get_order", arguments: '{"id":1}' } }],
        }),
      }),
    ].join("\n");

    const { text, stats } = buildJudgeInput("t1", jsonl);

    expect(stats.pass).toBe(1);
    expect(text).toContain("[1] agent · AGENT · OK · 1.25s · 79 tokens");
    expect(text).toContain("[2] chat · LLM · gpt-x · OK");
    expect(text).toContain("parent [1]");
    expect(text).toContain("input system: Be brief.");
    expect(text).toContain('output assistant: [tool call] get_order({"id":1})');
    expect(text).not.toContain("ch_create_time");
    expect(text).not.toContain("project_id");
  });

  it("drops metadata values that copy the input or output, and known SDK copies", () => {
    const prompt = [{ role: "user", content: "Refund O-5521?" }];
    const jsonl = row({
      span_id: "l1",
      name: "ai.generateText",
      span_kind: "LLM",
      input: JSON.stringify(prompt),
      output: '"Approved."',
      metadata: JSON.stringify({
        "ai.prompt.messages": JSON.stringify(prompt),
        "ai.prompt": JSON.stringify({ messages: prompt }),
        "ai.response.text": "Approved.",
        "copy.of.output": "Approved.",
        "ai.settings.maxRetries": 2,
      }),
    });

    const { text, stats } = buildJudgeInput("t1", jsonl);

    expect(stats.dropped_metadata_values).toBe(4);
    expect(text).toContain("metadata ai.settings.maxRetries: 2");
    expect(text).not.toContain("copy.of.output");
    expect(text.match(/Refund O-5521/g)).toHaveLength(1);
  });

  it("always shortens long metadata values to head and tail", () => {
    const jsonl = row({
      span_id: "s1",
      name: "step",
      span_kind: "SPAN",
      metadata: JSON.stringify({ blob: `START${"x".repeat(5_000)}END` }),
    });

    const { text } = buildJudgeInput("t1", jsonl);

    expect(text).toContain("START");
    expect(text).toContain("END");
    expect(text).toContain("... (4008 chars truncated) ...");
  });

  it("pass 2 shortens long texts but keeps LLM outputs whole", () => {
    const answer = `FINAL ${"a".repeat(3_000)} ANSWER`;
    const jsonl = [
      row({
        span_id: "t1",
        name: "search",
        span_kind: "TOOL",
        input: '"q"',
        output: JSON.stringify(filler("Result line", 20_000)),
      }),
      row({
        span_id: "l1",
        name: "chat",
        span_kind: "LLM",
        input: '"q"',
        output: JSON.stringify(answer),
      }),
    ].join("\n");

    const { text, stats } = buildJudgeInput("t1", jsonl, { budgetChars: 10_000 });

    expect(stats.pass).toBe(2);
    // The keep length grows to use the budget, not just the 500-char minimum.
    expect(stats.keep_chars).toBeGreaterThan(2_000);
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text).toContain(answer);
    expect(text).toMatch(/\.\.\. \(\d+ chars truncated\) \.\.\./);
    expect(text).toContain("Result line 1.");
  });

  it("pass 3 also shortens LLM outputs when they alone are over the budget", () => {
    const jsonl = Array.from({ length: 5 }, (_, i) =>
      row({
        span_id: `s${i}`,
        name: `step-${i}`,
        span_kind: "LLM",
        input: '"q"',
        output: JSON.stringify(filler("Out", 5_000)),
      }),
    ).join("\n");

    const { text, stats } = buildJudgeInput("t1", jsonl, { budgetChars: 12_000 });

    expect(stats.pass).toBe(3);
    expect(stats.shortened_texts).toBe(5);
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(text).not.toContain("SAMPLED VIEW");
  });

  it("pass 4 samples numbered lines under the budget", () => {
    const jsonl = Array.from({ length: 200 }, (_, i) =>
      row({
        span_id: `s${i}`,
        name: `step-${i}`,
        span_kind: "LLM",
        input: '"q"',
        output: JSON.stringify(filler("Out", 3_000)),
      }),
    ).join("\n");

    const { text, stats } = buildJudgeInput("t1", jsonl, { budgetChars: 20_000 });

    expect(stats.pass).toBe(4);
    expect(text.length).toBeLessThanOrEqual(20_000);
    expect(text).toContain("[SAMPLED VIEW: Showing ~");
    expect(text.split("\n")[0]).toMatch(/^L\d+: TRACE t1 · 200 spans/);
  });

  describe("SDK copies", () => {
    const prompt = `PROMPT ${"p".repeat(3_000)} END`;
    const span = (input: string) =>
      row({
        span_id: "a1",
        name: "ai.generateText",
        span_kind: "AGENT",
        input,
        output: '"done"',
        metadata: JSON.stringify({ "ai.prompt": prompt, "ai.response.text": "done" }),
      });

    it("keeps a copy whole when its column is empty", () => {
      const { text, stats } = buildJudgeInput("t1", span(""));
      expect(stats.dropped_metadata_values).toBe(1);
      expect(text).toContain(`metadata ai.prompt: ${prompt}`);
    });

    it("drops a copy when its column is set", () => {
      const { text, stats } = buildJudgeInput("t1", span('"hi"'));
      expect(stats.dropped_metadata_values).toBe(2);
      expect(text).not.toContain("PROMPT");
    });

    it("keeps an output copy when the output column is empty", () => {
      const { text, stats } = buildJudgeInput(
        "t1",
        row({
          span_id: "a1",
          name: "ai.generateText",
          span_kind: "AGENT",
          input: '"hi"',
          metadata: JSON.stringify({ "ai.prompt": "hi", "ai.response.text": "ANSWER" }),
        }),
      );
      expect(stats.dropped_metadata_values).toBe(1);
      expect(text).toContain("metadata ai.response.text: ANSWER");
    });

    it("keeps only one input copy when ai.prompt and ai.prompt.messages are both present", () => {
      const messages = JSON.stringify([{ role: "user", content: "MESSAGES" }]);
      const { text, stats } = buildJudgeInput(
        "t1",
        row({
          span_id: "a1",
          name: "ai.generateText",
          span_kind: "AGENT",
          output: '"done"',
          metadata: JSON.stringify({ "ai.prompt": prompt, "ai.prompt.messages": messages }),
        }),
      );
      expect(stats.dropped_metadata_values).toBe(1);
      expect(text).toContain("MESSAGES");
      expect(text).not.toContain("PROMPT");
    });
  });

  it("skips lines that are not JSON objects", () => {
    const { stats } = buildJudgeInput(
      "t1",
      `not json\n[1]\n${row({ span_id: "a", name: "x", span_kind: "SPAN" })}`,
    );
    expect(stats.skipped_lines).toBe(2);
    expect(stats.span_count).toBe(1);
  });
});

describe("sampleLines", () => {
  it("returns short text unchanged", () => {
    expect(sampleLines("a\nb", 100)).toBe("a\nb");
  });

  it("keeps the first lines, adds the note and stays under the budget", () => {
    const text = Array.from({ length: 1_000 }, (_, i) => `line ${i}`).join("\n");
    const out = sampleLines(text, 2_000);
    const lines = out.split("\n");
    expect(out.length).toBeLessThanOrEqual(2_000);
    expect(lines[0]).toBe("L0001: line 0");
    expect(lines[3]).toMatch(/^\[SAMPLED VIEW: Showing ~\d+% of 1,000 lines\./);
  });
});
