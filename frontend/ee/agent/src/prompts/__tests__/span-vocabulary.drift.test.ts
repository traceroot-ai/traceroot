/**
 * Drift guards for the span vocabulary the model reads.
 *
 * The system prompt and the tool descriptions are prose, so nothing type-checks
 * them against the data. A stale schema section once taught the agent a span
 * kind ingest never writes (GENERATION), and the alerts it built on it saved
 * fine and matched nothing. These tests tie that prose to its sources:
 *
 * - every span_kind / status value the model is shown must be one ingest writes
 *   (`SpanKind` / `SpanStatus`, themselves pinned to `backend/shared/enums.py`
 *   by core's span-enums parity test);
 * - every field the prompt lists for trace.jsonl / spans.jsonl must exist on
 *   the API response download_traces writes those files from.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { Executor } from "../../executors/interface.js";
import { createTools } from "../../tools/index.js";
import { getSystemPrompt } from "../system.js";

const TRACES_SCHEMA_PY = fileURLToPath(
  new URL("../../../../../../backend/rest/schemas/traces.py", import.meta.url),
);

/** Words from the schema the prompt once described, which TraceRoot does not have. */
const FOREIGN_VOCABULARY = [
  /\bGENERATION\b/,
  /\bobservations? table\b/i,
  /\bparent_observation_id\b/,
  /\blevel\s*[=(]/,
];

/** The values a text pins for one field: `f == "X"`, `f = X`, `f (A|B)`, `f is one of A, B`, `f is A or B`. */
function valuesNamedFor(field: string, text: string): string[] {
  const at = `(?<![A-Za-z_])${field}(?![A-Za-z_])`;
  const values: string[] = [];
  for (const m of text.matchAll(new RegExp(`${at}\\s*==?\\s*\\\\?["'\`]?([A-Za-z_]+)`, "g"))) {
    values.push(m[1]!);
  }
  for (const m of text.matchAll(new RegExp(`${at}\\s*\\(([A-Za-z_]+(?:\\|[A-Za-z_]+)+)\\)`, "g"))) {
    values.push(...m[1]!.split("|"));
  }
  for (const m of text.matchAll(
    new RegExp(`${at} is (?:one of )?([A-Z_]+(?:(?:, | or |, or )[A-Z_]+)*)`, "g"),
  )) {
    values.push(...m[1]!.split(/, or |, | or /));
  }
  return values;
}

/** Everything the model reads: the system prompt and each tool's description and parameters. */
function modelFacingTexts(): Array<{ source: string; text: string }> {
  const tools = createTools({
    projectId: "p1",
    userId: "u1",
    workspaceId: "w1",
    agentSessionId: "s1",
    executor: {} as Executor,
  });
  return [
    { source: "system prompt", text: getSystemPrompt({ projectId: "p1", traceId: "t1" }) },
    ...tools.map((tool) => ({
      source: `tool ${tool.name}`,
      text: `${tool.description}\n${JSON.stringify(tool.parameters)}`,
    })),
  ];
}

/** The field names declared on the named Pydantic classes, in source order. */
function pydanticFields(source: string, classNames: string[]): Set<string> {
  const fields = new Set<string>();
  for (const name of classNames) {
    const body = source.match(
      new RegExp(`^class ${name}\\(.*\\):\\n([\\s\\S]*?)(?=^\\S)`, "m"),
    )?.[1];
    if (!body) throw new Error(`class ${name} not found in backend/rest/schemas/traces.py`);
    for (const m of body.matchAll(/^ {4}([a-z_][a-z0-9_]*): \S/gm)) fields.add(m[1]!);
  }
  return fields;
}

/** The comma-separated "Key fields:" list under one `### <heading>` of the prompt. */
function promptKeyFields(prompt: string, heading: string): string[] {
  const section = prompt.split(`### ${heading}\n`)[1]?.split("\n\n")[0];
  if (!section) throw new Error(`### ${heading} not found in the system prompt`);
  return section
    .replace(/^Key fields:\s*/, "")
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
}

describe("span vocabulary the model reads", () => {
  beforeEach(() => {
    process.env.BACKEND_INTERNAL_URL = "http://fastapi.test";
    process.env.INTERNAL_API_SECRET = "s3cret";
  });

  afterEach(() => {
    delete process.env.BACKEND_INTERNAL_URL;
    delete process.env.INTERNAL_API_SECRET;
  });

  it("names only span kinds and statuses that ingest writes", () => {
    const kinds = new Set<string>(Object.values(SpanKind));
    const statuses = new Set<string>(Object.values(SpanStatus));
    const strays: string[] = [];
    for (const { source, text } of modelFacingTexts()) {
      for (const v of valuesNamedFor("span_kind", text)) {
        if (!kinds.has(v)) strays.push(`${source}: span_kind ${v}`);
      }
      for (const v of valuesNamedFor("status", text)) {
        if (!statuses.has(v)) strays.push(`${source}: status ${v}`);
      }
    }
    expect(strays).toEqual([]);
  });

  it("actually finds the values it checks, so a reworded text cannot pass vacuously", () => {
    const named = (source: string) =>
      valuesNamedFor("span_kind", modelFacingTexts().find((t) => t.source === source)!.text);
    expect(named("system prompt")).toContain(SpanKind.LLM);
    expect(named("tool create_alert")).toEqual(Object.values(SpanKind));
  });

  it("carries none of the vocabulary of a schema TraceRoot does not have", () => {
    const hits = modelFacingTexts().flatMap(({ source, text }) =>
      FOREIGN_VOCABULARY.filter((word) => word.test(text)).map((word) => `${source}: ${word}`),
    );
    expect(hits).toEqual([]);
  });

  it("flags the stale text this guard exists for", () => {
    expect(valuesNamedFor("span_kind", `jq 'select(.span_kind == "GENERATION")'`)).toEqual([
      "GENERATION",
    ]);
    expect(valuesNamedFor("status", "errors (status=WARNING)")).toEqual(["WARNING"]);
    expect(valuesNamedFor("span_kind", "span_kind is one of LLM, GENERATION or TOOL")).toEqual([
      "LLM",
      "GENERATION",
      "TOOL",
    ]);
  });
});

describe("trace and span fields the prompt lists", () => {
  const schema = readFileSync(TRACES_SCHEMA_PY, "utf8");
  const prompt = getSystemPrompt({ projectId: "p1" });

  it("lists only spans.jsonl fields that the trace API returns on a span", () => {
    const real = pydanticFields(schema, ["SpanSkeletonResponse", "SpanResponse"]);
    const listed = promptKeyFields(prompt, "spans.jsonl");
    expect(listed.length).toBeGreaterThan(10);
    expect(listed.filter((field) => !real.has(field))).toEqual([]);
  });

  it("lists only trace.jsonl fields that the trace API returns on a trace", () => {
    const real = pydanticFields(schema, ["TraceDetailResponse"]);
    real.delete("spans"); // download_traces writes spans to their own file
    const listed = promptKeyFields(prompt, "trace.jsonl");
    expect(listed.length).toBeGreaterThan(5);
    expect(listed.filter((field) => !real.has(field))).toEqual([]);
  });
});
