// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MetadataJson } from "./MetadataJson";
import type { MetadataEntry } from "../utils/metadata";

afterEach(cleanup);

const entry = (key: string, rawValue: unknown): MetadataEntry => ({
  key,
  value: typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue),
  rawValue,
  isFilterable: typeof rawValue === "string",
});

/** The rendered document as text, which is what the reader is being shown. */
function renderText(entries: MetadataEntry[]): string {
  const { container } = render(<MetadataJson entries={entries} />);
  const root = container.firstElementChild;
  if (root === null) throw new Error("MetadataJson rendered nothing");
  return Array.from(root.children)
    .map((line) => line.textContent)
    .join("\n");
}

describe("MetadataJson", () => {
  it("frames the entries in braces on their own lines", () => {
    const text = renderText([entry("service", "api")]);
    expect(text).toBe('{\n"service": "api"\n}');
  });

  it("separates entries with a comma but does not trail one after the last", () => {
    const text = renderText([entry("a", "1"), entry("b", "2"), entry("c", "3")]);
    expect(text).toBe('{\n"a": "1",\n"b": "2",\n"c": "3"\n}');
  });

  it("renders each value in its JSON spelling, so only strings are quoted", () => {
    const text = renderText([
      entry("quality", 0.9),
      entry("policy_pass", true),
      entry("owner", null),
      entry("note", "hi"),
    ]);
    expect(text).toBe('{\n"quality": 0.9,\n"policy_pass": true,\n"owner": null,\n"note": "hi"\n}');
  });

  it("escapes a key that contains a quote instead of printing it raw", () => {
    // Rendered as-is this would close the key early and stop being valid JSON.
    expect(renderText([entry('a"b', "v")])).toBe('{\n"a\\"b": "v"\n}');
  });

  it("escapes a value that contains a quote", () => {
    expect(renderText([entry("k", 'say "hi"')])).toBe('{\n"k": "say \\"hi\\""\n}');
  });

  describe("truncation", () => {
    it("leaves a value that fits exactly as JSON.stringify would write it", () => {
      const fits = "a".repeat(42);
      expect(renderText([entry("k", fits)])).toBe(`{\n"k": "${fits}"\n}`);
    });

    it("puts the ellipsis inside the closing quote so the value still reads as a string", () => {
      const long = "a".repeat(60);
      expect(renderText([entry("k", long)])).toBe(`{\n"k": "${"a".repeat(42)}…"\n}`);
    });

    it("does not split a surrogate pair when the cut lands on one", () => {
      // Slicing the serialized text by UTF-16 unit would keep half the emoji and render U+FFFD.
      const text = renderText([entry("k", `${"a".repeat(41)}😀tail`)]);
      expect(text).not.toContain("�");
      expect(text).toBe(`{\n"k": "${"a".repeat(41)}😀…"\n}`);
    });

    it("does not leave a half-written escape sequence at the cut", () => {
      // Serializing first would put a lone backslash before the ellipsis.
      const text = renderText([entry("k", `${"a".repeat(41)}"tail`)]);
      expect(text).toBe(`{\n"k": "${"a".repeat(41)}\\"…"\n}`);
    });

    it("shortens a structured value without pretending it is a string", () => {
      const text = renderText([entry("k", { note: "b".repeat(60) })]);
      expect(text).toMatch(/^\{\n"k": \{"note":"b+…\n\}$/);
    });
  });

  it("renders nothing but the braces when there are no entries", () => {
    expect(renderText([])).toBe("{\n}");
  });

  it("colours keys apart from values, and never in the palette the project bars", () => {
    const { container } = render(<MetadataJson entries={[entry("service", "api")]} />);
    expect(screen.getByText('"service"').className).toContain("text-blue-600");
    expect(container.innerHTML).not.toContain("purple");
  });
});
