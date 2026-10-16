/**
 * Cross-language drift guard for the span vocabulary.
 *
 * Ingest (Python) decides which span_kind and status values a span can carry:
 * `backend/shared/enums.py` is what `otel_transform.py` writes. The TypeScript
 * constants here are what the UI, the alert filters and the agent's prompt and
 * tool text are built from. If the two lists drift, the agent can name a kind
 * ingest never writes, and a filter on it saves fine but matches nothing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SpanKind, SpanStatus } from "../constants.ts";

const ENUMS_PY = fileURLToPath(new URL("../../../../../backend/shared/enums.py", import.meta.url));

/** The string values of one `class Name(StrEnum):` block. */
function pythonEnumValues(source: string, name: string): string[] {
  const body = source.match(
    new RegExp(`^class ${name}\\(StrEnum\\):\\n((?:[ \\t]+.*\\n|\\n)+)`, "m"),
  )?.[1];
  if (!body) throw new Error(`class ${name}(StrEnum) not found in backend/shared/enums.py`);
  return [...body.matchAll(/^[ \t]+[A-Z_]+\s*=\s*"([^"]+)"/gm)].map((m) => m[1]!);
}

describe("span vocabulary parity with ingest", () => {
  const source = readFileSync(ENUMS_PY, "utf8");

  it("SpanKind lists exactly the kinds ingest writes", () => {
    expect(Object.values(SpanKind).sort()).toEqual(pythonEnumValues(source, "SpanKind").sort());
  });

  it("SpanStatus lists exactly the statuses ingest writes", () => {
    expect(Object.values(SpanStatus).sort()).toEqual(pythonEnumValues(source, "SpanStatus").sort());
  });

  it("reads a non-empty roster, so an unparsable file cannot pass vacuously", () => {
    expect(pythonEnumValues(source, "SpanKind")).toContain("LLM");
    expect(pythonEnumValues(source, "SpanStatus")).toContain("ERROR");
  });
});
