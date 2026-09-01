import { describe, expect, it } from "vitest";
import {
  extractTemplatePrompt,
  loadCatalogSource,
  makeCanonicalPrompt,
} from "../template-catalog.js";

const CATALOG_FIXTURE = `
export const DETECTOR_TEMPLATES: DetectorTemplate[] = [
  {
    id: "failure",
    label: "Failure",
    description: "Tool errors",
    prompt: \`Analyze this trace for failures:
- timeouts
- retries\`,
    outputSchema: [],
  },
  {
    id: "blank",
    label: "Blank",
    description: "Start from scratch",
    prompt: "",
    outputSchema: [],
  },
];
`;

describe("extractTemplatePrompt", () => {
  it("returns a backtick-quoted multi-line prompt verbatim", () => {
    expect(extractTemplatePrompt(CATALOG_FIXTURE, "failure")).toBe(
      "Analyze this trace for failures:\n- timeouts\n- retries",
    );
  });

  it("returns a double-quoted prompt", () => {
    expect(extractTemplatePrompt(CATALOG_FIXTURE, "blank")).toBe("");
  });

  it("throws for a template id the catalog does not define", () => {
    expect(() => extractTemplatePrompt(CATALOG_FIXTURE, "nope")).toThrow(/nope/);
  });

  it("throws when the matched entry has no prompt field", () => {
    const malformed = `[{ id: "failure", label: "Failure" }]`;
    expect(() => extractTemplatePrompt(malformed, "failure")).toThrow(/prompt/);
  });

  it("does not bleed into the next entry's prompt", () => {
    // "blank" follows "failure"; a greedy match would return failure's text.
    expect(extractTemplatePrompt(CATALOG_FIXTURE, "blank")).not.toMatch(/timeouts/);
  });

  it("unescapes an escaped quote inside the prompt", () => {
    const source = String.raw`[{ id: "x", prompt: "say \"hi\" now", outputSchema: [] }]`;
    expect(extractTemplatePrompt(source, "x")).toBe('say "hi" now');
  });

  it("throws when the prompt literal is never closed", () => {
    expect(() => extractTemplatePrompt('[{ id: "x", prompt: "unclosed', "x")).toThrow(
      /unterminated/,
    );
  });

  it("throws when the prompt is not a literal it can read", () => {
    expect(() => extractTemplatePrompt('[{ id: "x", prompt: SHARED_PROMPT, }]', "x")).toThrow(
      /unreadable/,
    );
  });

  it("refuses an interpolated prompt, which cannot be resolved from source", () => {
    expect(() => extractTemplatePrompt('[{ id: "x", prompt: `hello ${name}`, }]', "x")).toThrow(
      /interpolates/,
    );
  });
});

describe("loadCatalogSource", () => {
  it("reads the UI-owned detector template catalog", () => {
    const source = loadCatalogSource();
    expect(source).toMatch(/DETECTOR_TEMPLATES/);
    expect(source).toMatch(/id: "failure",/);
  });
});

describe("makeCanonicalPrompt", () => {
  it("resolves the real failure template's canonical prompt", () => {
    const canonicalPrompt = makeCanonicalPrompt();
    const prompt = canonicalPrompt("failure");

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toMatch(/^Analyze this trace/);
  });

  it("reads the catalog once and reuses it across lookups", () => {
    const canonicalPrompt = makeCanonicalPrompt();
    expect(canonicalPrompt("failure")).toBe(canonicalPrompt("failure"));
  });
});
