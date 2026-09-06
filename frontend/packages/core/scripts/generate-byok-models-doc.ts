/**
 * Rewrite the generated model region of docs/ai-agent/byok.mdx from the
 * selectable model catalog. Run with: pnpm --filter @traceroot/core generate:byok-docs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BYOK_DOC_END, BYOK_DOC_START, renderByokModelsSection } from "../src/byok-docs";

const docPath = fileURLToPath(new URL("../../../../docs/ai-agent/byok.mdx", import.meta.url));
const doc = readFileSync(docPath, "utf8");

const start = doc.indexOf(BYOK_DOC_START);
const end = doc.indexOf(BYOK_DOC_END);
if (start === -1 || end === -1) {
  throw new Error(`markers not found in ${docPath} — expected ${BYOK_DOC_START}`);
}

const updated =
  doc.slice(0, start) + renderByokModelsSection() + doc.slice(end + BYOK_DOC_END.length);
writeFileSync(docPath, updated);
console.log(`updated ${docPath}`);
