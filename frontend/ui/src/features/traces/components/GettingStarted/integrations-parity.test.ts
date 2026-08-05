import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ADAPTER_CONFIG } from "@traceroot/core";
import { INTEGRATIONS } from "./integrations";

// This suite is a drift guard for issue #1795: BYOK model providers
// (ADAPTER_CONFIG, the source of truth) must stay in sync with every
// display surface that's supposed to list them — the getting-started
// picker and the docs. It intentionally does NOT cover "instrumentation
// integrations" (agent frameworks) against the Python/TS SDK enums —
// those enums live in the traceroot-py / traceroot-ts repos, which are
// not part of this checkout, so there is no source-of-truth file here
// to check against.

// ADAPTER_CONFIG keys the same provider `google` where docs/picker call
// it `gemini`. Every other key matches its docs/picker id verbatim.
const ADAPTER_ID_TO_DOCS_ID: Record<string, string> = {
  google: "gemini",
};

// AWS Bedrock needs boto3-based instrumentation with no verified
// `Integration` enum member available to this repo (see its docs page) —
// intentionally left out of the getting-started picker, which cannot
// render an entry with zero code examples (see ManualTab.tsx's guard).
const PICKER_EXCEPTIONS = new Set(["amazon-bedrock"]);

const DOCS_ROOT = path.resolve(process.cwd(), "../../docs");
const INTEGRATIONS_DIR = path.join(DOCS_ROOT, "integrations");
const OVERVIEW_MDX_PATH = path.join(INTEGRATIONS_DIR, "overview.mdx");
const BYOK_MDX_PATH = path.join(DOCS_ROOT, "ai-agent", "byok.mdx");
const DOCS_JSON_PATH = path.join(DOCS_ROOT, "docs.json");

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

// Recursively collect every `docs.json` "pages" entry, repo-wide — not just
// under the Integrations tab — so this doesn't silently stop working if the
// nav gets reorganized.
function collectDocsJsonPages(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectDocsJsonPages(item, out);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "pages" && Array.isArray(value)) {
        for (const page of value) {
          if (typeof page === "string") out.push(page);
        }
      } else {
        collectDocsJsonPages(value, out);
      }
    }
  }
  return out;
}

const byokIds = Object.keys(ADAPTER_CONFIG).map((key) => ADAPTER_ID_TO_DOCS_ID[key] ?? key);

const pickerProviderIds = INTEGRATIONS.filter((i) => i.category === "provider").map((i) => i.id);

const docsJsonPages = collectDocsJsonPages(JSON.parse(readText(DOCS_JSON_PATH)));
const docsJsonIntegrationIds = docsJsonPages
  .filter((p) => p.startsWith("integrations/"))
  .map((p) => p.replace("integrations/", ""));

const mdxFileIds = fs
  .readdirSync(INTEGRATIONS_DIR)
  .filter((f) => f.endsWith(".mdx"))
  .map((f) => f.replace(/\.mdx$/, ""));

const overviewMdx = readText(OVERVIEW_MDX_PATH);
const overviewLinkedIds = Array.from(overviewMdx.matchAll(/\/integrations\/([a-z0-9-]+)"/g)).map(
  (m) => m[1],
);

describe("BYOK model providers stay in sync with the picker and docs (#1795)", () => {
  it("every ADAPTER_CONFIG provider has a docs.json nav entry", () => {
    for (const id of byokIds) {
      expect(docsJsonIntegrationIds, `${id} missing from docs.json nav`).toContain(id);
    }
  });

  it("every ADAPTER_CONFIG provider has a docs/integrations/*.mdx page", () => {
    for (const id of byokIds) {
      expect(mdxFileIds, `${id} missing a docs/integrations/*.mdx page`).toContain(id);
    }
  });

  it("every ADAPTER_CONFIG provider has an overview.mdx card", () => {
    for (const id of byokIds) {
      expect(overviewLinkedIds, `${id} missing an overview.mdx card`).toContain(id);
    }
  });

  it("every ADAPTER_CONFIG provider (except documented exceptions) has a getting-started picker entry", () => {
    for (const id of byokIds) {
      if (PICKER_EXCEPTIONS.has(id)) continue;
      expect(pickerProviderIds, `${id} missing from the getting-started picker`).toContain(id);
    }
  });

  // Not tested in reverse: the picker's "provider" category means
  // "instrumentable" (you can trace your own calls to it), which is a
  // legitimately broader set than "BYOK-configurable" — e.g. Mistral is
  // instrumentable but isn't in ADAPTER_CONFIG, and that's not drift.
});

describe("Docs stay in 1:1 correspondence: overview.mdx cards, docs.json nav, *.mdx files (#1795)", () => {
  it("every docs/integrations/*.mdx file has a docs.json nav entry, and vice versa", () => {
    expect([...mdxFileIds].sort()).toEqual([...docsJsonIntegrationIds].sort());
  });

  it("every docs/integrations/*.mdx file except overview.mdx itself is linked from overview.mdx", () => {
    const expected = mdxFileIds.filter((id) => id !== "overview");
    expect([...overviewLinkedIds].sort()).toEqual([...expected].sort());
  });
});

describe("Instrumentation and BYOK model providers are labeled as distinct concepts (#1796)", () => {
  it("overview.mdx's Model Providers section cross-references the BYOK docs", () => {
    const overview = readText(OVERVIEW_MDX_PATH);
    expect(overview).toContain("## Model Providers (Traced Automatically)");
    expect(overview).toContain("/ai-agent/byok");
  });

  it("byok.mdx's Supported Providers section cross-references the instrumentation docs", () => {
    const byok = readText(BYOK_MDX_PATH);
    expect(byok).toContain("/integrations/overview");
  });
});
