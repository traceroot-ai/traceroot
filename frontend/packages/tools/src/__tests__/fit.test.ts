import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_VALUE_CHARS, fitToBudget } from "../fit.js";

const hint = "Ask for less and call again.";

describe("fitToBudget", () => {
  it("returns a result under the limit unchanged", () => {
    const value = { data: [1, 2, 3] };
    const fitted = fitToBudget(value, 1_000, { hint });
    expect(fitted).toEqual({ value, text: '{"data":[1,2,3]}', truncated: false });
  });

  it("cuts long strings first, with a marker that says how much went", () => {
    const long = "y".repeat(DEFAULT_MAX_VALUE_CHARS + 500);
    const fitted = fitToBudget({ input: long, name: "ok" }, 10_300, { hint });
    expect(fitted.truncated).toBe(true);
    expect(fitted.text.length).toBeLessThanOrEqual(10_300);
    const parsed = JSON.parse(fitted.text);
    expect(parsed.name).toBe("ok");
    expect(parsed.input).toBe("y".repeat(DEFAULT_MAX_VALUE_CHARS) + "…[truncated 500 chars]");
    expect(parsed._hint).toBe(hint);
    expect(parsed).not.toHaveProperty("_truncated");
    expect(fitted.value).toEqual(parsed);
  });

  it("drops the tail of the largest list, keeps the head, and counts what went by path", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, note: "z".repeat(100) }));
    const tags = ["a", "b", "c"];
    const fitted = fitToBudget({ data: rows, tags, next_cursor: "abc" }, 5_000, { hint });
    expect(fitted.text.length).toBeLessThanOrEqual(5_000);
    const parsed = JSON.parse(fitted.text);
    expect(parsed.data[0].id).toBe("row-0");
    expect(parsed.data.length).toBeLessThan(200);
    expect(parsed._truncated).toEqual({ data: 200 - parsed.data.length });
    // Smaller lists and scalars are left alone.
    expect(parsed.tags).toEqual(tags);
    expect(parsed.next_cursor).toBe("abc");
  });

  it("reaches into nested lists with an indexed path", () => {
    const spans = Array.from({ length: 300 }, (_, i) => ({
      span_id: `s${i}`,
      name: "n".repeat(50),
    }));
    const fitted = fitToBudget({ trace: { spans } }, 3_000, { hint });
    const parsed = JSON.parse(fitted.text);
    expect(fitted.text.length).toBeLessThanOrEqual(3_000);
    expect(Object.keys(parsed._truncated)).toEqual(["trace.spans"]);
    expect(parsed.trace.spans.length + parsed._truncated["trace.spans"]).toBe(300);
  });

  it("moves a list at the root under items so it can carry the markers", () => {
    const list = Array.from({ length: 100 }, (_, i) => `item-${i}-${"q".repeat(40)}`);
    const fitted = fitToBudget(list, 1_000, { hint });
    const parsed = JSON.parse(fitted.text);
    expect(Array.isArray(parsed.items)).toBe(true);
    expect(parsed._truncated.items).toBe(100 - parsed.items.length);
  });

  it("lowers the string cap when there is no list left to shorten", () => {
    const value = { a: "a".repeat(9_000), b: "b".repeat(9_000), c: "c".repeat(9_000) };
    const fitted = fitToBudget(value, 4_000, { hint });
    expect(fitted.text.length).toBeLessThanOrEqual(4_000);
    const parsed = JSON.parse(fitted.text);
    for (const key of ["a", "b", "c"]) {
      expect(parsed[key]).toMatch(/^[abc]+…\[truncated \d+ chars\]$/);
    }
  });

  it("always returns parseable JSON within the limit, however small", () => {
    const value = { rows: Array.from({ length: 50 }, (_, i) => ({ i, v: "w".repeat(300) })) };
    for (const limit of [10_000, 2_000, 600, 300, 100, 30]) {
      const fitted = fitToBudget(value, limit, { hint });
      expect(() => JSON.parse(fitted.text)).not.toThrow();
      expect(fitted.text.length).toBeLessThanOrEqual(limit);
      expect(fitted.truncated).toBe(true);
    }
  });

  it("encodes a scalar result as-is when it fits", () => {
    expect(fitToBudget("hello", 100).text).toBe('"hello"');
    expect(fitToBudget(null, 100).text).toBe("null");
  });
});
