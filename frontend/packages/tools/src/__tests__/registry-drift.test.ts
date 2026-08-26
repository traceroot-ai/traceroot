import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// Imported through the package entry point so the public surface is exercised.
import { generateRegistry, REGISTRY, type OpenApiDocument } from "../index.js";

const schemaPath = fileURLToPath(
  new URL("../../../../../backend/rest/openapi/public.json", import.meta.url),
);

describe("committed registry", () => {
  it("matches a fresh generation from the committed public schema (no drift)", () => {
    const doc = JSON.parse(readFileSync(schemaPath, "utf8")) as OpenApiDocument;
    expect(REGISTRY).toEqual(generateRegistry(doc));
  });

  it("pins the curated tool surface", () => {
    expect(REGISTRY.map((entry) => entry.name)).toEqual([
      "export_trace",
      "get_detector",
      "get_finding",
      "get_finding_by_trace",
      "get_session",
      "get_trace",
      "list_detectors",
      "list_findings",
      "list_sessions",
      "list_trace_filter_values",
      "list_traces",
      "whoami",
    ]);
  });
});
