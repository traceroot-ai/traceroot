import { describe, it, expect } from "vitest";
import { getSpanKindColor, getSpanKindIcon } from "./SpanKindIcon";

describe("getSpanKindColor", () => {
  it("returns distinct surface tints for the four real kinds", () => {
    const surfaces = ["LLM", "AGENT", "TOOL", "SPAN"].map((k) => getSpanKindColor(k).surface);
    expect(new Set(surfaces).size).toBe(4);
  });

  it("maps each kind to its hue", () => {
    expect(getSpanKindColor("LLM").surface).toContain("violet");
    expect(getSpanKindColor("AGENT").surface).toContain("blue");
    expect(getSpanKindColor("TOOL").surface).toContain("amber");
    expect(getSpanKindColor("SPAN").surface).toContain("slate");
  });

  it("is case-insensitive", () => {
    expect(getSpanKindColor("llm")).toEqual(getSpanKindColor("LLM"));
  });

  it("falls back to the neutral span tint for unknown kinds", () => {
    expect(getSpanKindColor("http")).toEqual(getSpanKindColor("SPAN"));
  });

  it("returns a quiet neutral surface for the trace root", () => {
    const surface = getSpanKindColor("trace").surface;
    expect(surface).not.toContain("violet");
    expect(surface).not.toContain("blue");
    expect(surface).not.toContain("amber");
  });

  it("includes a dark-mode variant in every glyph color", () => {
    for (const k of ["LLM", "AGENT", "TOOL", "SPAN"]) {
      expect(getSpanKindColor(k).glyph).toContain("dark:");
    }
  });

  it("gives the offline-eval kinds distinct tints (not the SPAN fallback)", () => {
    expect(getSpanKindColor("EVALUATION").surface).toContain("emerald");
    expect(getSpanKindColor("TASK").surface).toContain("sky");
    expect(getSpanKindColor("SCORER").surface).toContain("fuchsia");
    for (const k of ["EVALUATION", "TASK", "SCORER"]) {
      expect(getSpanKindColor(k)).not.toEqual(getSpanKindColor("SPAN"));
    }
  });

  it("maps the offline-eval kinds to their own icons", () => {
    const span = getSpanKindIcon("SPAN");
    for (const k of ["EVALUATION", "TASK", "SCORER"]) {
      expect(getSpanKindIcon(k)).not.toBe(span);
    }
  });
});
