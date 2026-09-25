import { describe, it, expect } from "vitest";
import { highlightCode, normalizeLang, type CodeToken } from "./code-highlight";

/** Highlighting must be lossless: tokens always reconstruct the input exactly. */
const roundTrip = (tokens: CodeToken[]) => tokens.map((t) => t.text).join("");
const classOf = (tokens: CodeToken[], text: string) => tokens.find((t) => t.text === text)?.cls;

describe("normalizeLang", () => {
  it("maps the aliases we document", () => {
    expect(normalizeLang("py")).toBe("python");
    expect(normalizeLang("Python")).toBe("python");
    expect(normalizeLang("js")).toBe("javascript");
    expect(normalizeLang("ts")).toBe("typescript");
    expect(normalizeLang("json")).toBe("json");
  });

  it("returns null for unknown/absent languages", () => {
    expect(normalizeLang("rust")).toBeNull();
    expect(normalizeLang("")).toBeNull();
    expect(normalizeLang(null)).toBeNull();
  });
});

describe("highlightCode", () => {
  it("returns one plain token when the language is unknown", () => {
    const t = highlightCode("fn main() {}", null);
    expect(t).toEqual([{ text: "fn main() {}" }]);
  });

  it("classifies python comments, strings, keywords, numbers and calls", () => {
    const src = ["# greet", "def greet(name):", '    return f"hi {name}" if True else 1'].join(
      "\n",
    );
    const t = highlightCode(src, "python");
    expect(roundTrip(t)).toBe(src);
    expect(classOf(t, "# greet")).toContain("muted");
    expect(classOf(t, "def")).toContain("purple");
    expect(classOf(t, "True")).toContain("orange");
    expect(classOf(t, "1")).toContain("blue");
    expect(t.find((x) => x.text.includes('f"hi'))?.cls).toContain("green");
  });

  it("does not treat quotes inside a python triple-quoted string as a new string", () => {
    const src = '"""say "hi" now"""\nx = 1';
    const t = highlightCode(src, "python");
    expect(roundTrip(t)).toBe(src);
    expect(classOf(t, '"""say "hi" now"""')).toContain("green");
  });

  it("classifies javascript comments, template strings, keywords and constants", () => {
    const src = ["// note", "const x = `a${b}c`;", "if (x === null) run(1.5);"].join("\n");
    const t = highlightCode(src, "javascript");
    expect(roundTrip(t)).toBe(src);
    expect(classOf(t, "// note")).toContain("muted");
    expect(classOf(t, "const")).toContain("purple");
    expect(classOf(t, "`a${b}c`")).toContain("green");
    expect(classOf(t, "null")).toContain("orange");
    expect(classOf(t, "1.5")).toContain("blue");
    expect(classOf(t, "run")).toContain("sky");
  });

  it("highlights typescript with the javascript rules", () => {
    const t = highlightCode("interface A { b: string }", "typescript");
    expect(classOf(t, "interface")).toContain("purple");
  });

  it("distinguishes json keys from string values", () => {
    const src = '{"route": "billing"}';
    const t = highlightCode(src, "json");
    expect(roundTrip(t)).toBe(src);
    expect(classOf(t, '"route"')).toContain("sky");
    expect(classOf(t, '"billing"')).toContain("green");
  });

  it("is lossless on multi-line input and empty input", () => {
    const src = "def f():\n\n    pass\n";
    expect(roundTrip(highlightCode(src, "python"))).toBe(src);
    expect(highlightCode("", "python")).toEqual([]);
  });
});
