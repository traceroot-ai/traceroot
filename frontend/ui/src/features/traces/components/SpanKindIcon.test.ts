import { describe, it, expect } from "vitest";
import { getSpanKindColor, getSpanKindIcon } from "./SpanKindIcon";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";

describe("getSpanKindIcon", () => {
  it("maps each known kind to its domain icon", () => {
    expect(getSpanKindIcon("trace")).toBe(DOMAIN_ICONS.trace);
    expect(getSpanKindIcon("llm")).toBe(DOMAIN_ICONS.llm);
    expect(getSpanKindIcon("agent")).toBe(DOMAIN_ICONS.agent);
    expect(getSpanKindIcon("tool")).toBe(DOMAIN_ICONS.tool);
  });

  it("is case-insensitive", () => {
    expect(getSpanKindIcon("LLM")).toBe(DOMAIN_ICONS.llm);
  });

  it("falls back to the generic span icon for span and unknown kinds", () => {
    expect(getSpanKindIcon("span")).toBe(DOMAIN_ICONS.span);
    expect(getSpanKindIcon("http")).toBe(DOMAIN_ICONS.span);
  });
});

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
});
