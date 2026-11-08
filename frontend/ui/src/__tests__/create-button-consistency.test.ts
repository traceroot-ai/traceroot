import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx$/.test(e.name) && !/\.(test|spec)\.tsx$/.test(e.name) ? [p] : [];
  });
}

const files = sourceFiles(SRC).map(
  (f) => [path.relative(SRC, f), readFileSync(f, "utf8")] as const,
);

describe("create actions", () => {
  it("are written in sentence case: 'New detector', never 'New Detector'", () => {
    const offenders: string[] = [];
    for (const [file, text] of files) {
      for (const m of text.matchAll(
        /(?:^\s*|>\s*|title=")(?:＋\s*)?New ([A-Z][a-z]+)(?:\s*<|"|\s*$)/gm,
      )) {
        offenders.push(`${file}: ${m[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never prefix the label with a hand-typed plus sign (the button draws its own icon)", () => {
    const offenders = files
      .filter(([, text]) => /(?:^\s*|>\s*)＋ /m.test(text))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it("use one shared button: the AddButton default is the filled primary variant", () => {
    const addButton = readFileSync(path.join(SRC, "components/ui/add-button.tsx"), "utf8");
    expect(addButton).toMatch(/variant = "default"/);
  });
});
