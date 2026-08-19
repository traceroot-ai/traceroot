import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getSystemPrompt } from "../system.js";

// The detector template catalog is owned by the UI package; the system prompt
// hand-lists it. This guard turns silent drift between the two into a test
// failure (a stale entry has already slipped in once).
const catalogPath = fileURLToPath(
  new URL("../../../../../ui/src/features/detectors/templates.ts", import.meta.url),
);

function catalogTemplateIds(): string[] {
  const source = readFileSync(catalogPath, "utf8");
  return [...source.matchAll(/^\s{4}id: "([a-z0-9-]+)",$/gm)].map((m) => m[1]!);
}

describe("prompt template catalog", () => {
  it("lists exactly the UI catalog's template ids", () => {
    const ids = catalogTemplateIds();
    expect(ids.length).toBeGreaterThanOrEqual(5);

    const prompt = getSystemPrompt({ projectId: "proj-123" });
    const sentence = prompt.match(/Detectors are built from TraceRoot's templates: ([^.]+)\./)?.[1];
    expect(sentence).toBeTruthy();

    const listed = sentence!
      .split(/,|\bor\b/)
      .map((part) => part.trim().split(" ")[0])
      .filter(Boolean);
    expect([...listed].sort()).toEqual([...ids].sort());
  });
});
