/**
 * Regenerate src/registry.generated.ts from the committed public OpenAPI
 * schema. Run with: pnpm --filter @traceroot-ai/tools generate
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRegistry, type OpenApiDocument } from "../src/generate.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const schemaPath = join(packageDir, "../../../backend/rest/openapi/public.json");
const outputPath = join(packageDir, "src/registry.generated.ts");

const doc = JSON.parse(readFileSync(schemaPath, "utf8")) as OpenApiDocument;
const registry = generateRegistry(doc);

const banner = `// Generated from backend/rest/openapi/public.json — do not edit.
// Regenerate with: pnpm --filter @traceroot-ai/tools generate
`;

const contents = `${banner}import type { RegistryEntry } from "./types.js";

export const REGISTRY: readonly RegistryEntry[] = ${JSON.stringify(registry, null, 2)};
`;

writeFileSync(outputPath, contents);
console.log(`Wrote ${registry.length} registry entries to ${outputPath}`);
