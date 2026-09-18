import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Retention-gate wiring guard.
 *
 * `DateFilterSelect` renders the plan lock entirely from its `retentionDays`
 * prop, and `isOptionLocked` short-circuits to `false` for every option when
 * that prop is absent. A surface rendering the picker without it is therefore
 * not partly gated, it is completely ungated, and it looks correct: no lock,
 * no tooltip, no error, and the wider range is genuinely queried.
 *
 * That is the shape of the Evaluations bug (#1987) this guard exists to stop
 * recurring. The list surfaces wired the prop, Evaluations did not, and
 * nothing failed until someone compared two dropdowns by hand.
 *
 * Reading the source rather than rendering each page is deliberate: the
 * property is "every call site passes the prop", and a render test only covers
 * the pages someone remembered to write a test for, which is the same gap
 * again.
 *
 * Most list pages reach the picker through `search-filter-bar`, so that
 * wrapper is a call site and the pages behind it are covered by the props it
 * forwards.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/**
 * Call sites that deliberately do not gate, with the reason.
 *
 * Both are preview controls inside a builder form rather than a surface that
 * lists a workspace's telemetry, which is the same reasoning #1987 recorded
 * for the dashboard widget-builder preview (that one uses raw `RANGE_PRESETS`
 * and so never reaches this scan). Listed rather than skipped, so the
 * exemption is a decision on the record and a NEW ungated surface still fails.
 */
const EXEMPT: Record<string, string> = {
  "features/alerts/components/alert-preview.tsx":
    "Live preview inside the alert rule form, not a telemetry list surface. " +
    "Same category as the widget-builder preview noted in #1987.",
};

/** Every .ts/.tsx file under src, excluding tests and the component itself. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__") sourceFiles(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    if (entry.startsWith("date-filter-select")) continue;
    out.push(path);
  }
  return out;
}

/**
 * The props on each `<DateFilterSelect ... />` element in one file.
 *
 * Taking everything up to the matching `/>` is enough here: the component is
 * always self-closing and its props are plain expressions, so there is no
 * nested JSX to confuse the match.
 */
function dateFilterUsages(source: string): string[] {
  const usages: string[] = [];
  const open = /<DateFilterSelect\b/g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source)) !== null) {
    const end = source.indexOf("/>", match.index);
    if (end === -1) continue;
    usages.push(source.slice(match.index, end));
  }
  return usages;
}

function callSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("DateFilterSelect")) continue;
    const usages = dateFilterUsages(source);
    if (usages.length > 0) sites.set(file.slice(SRC.length), usages);
  }
  return sites;
}

describe("every DateFilterSelect is wired to the plan's retention window", () => {
  it("finds the known call sites, so a rename cannot make this vacuous", () => {
    const files = [...callSites().keys()];
    // The shared list-page wrapper and the two direct renderers. If this fails
    // the scan stopped matching, not that a surface was removed.
    expect(files).toContain("components/search-filter-bar.tsx");
    expect(files).toContain("features/evaluations/views/evaluations-view.tsx");
    expect(files).toContain("app/projects/[projectId]/dashboard/[dashboardId]/page.tsx");
  });

  it("passes retentionDays at every call site that is not a documented exemption", () => {
    const ungated: string[] = [];
    for (const [file, usages] of callSites()) {
      if (file in EXEMPT) continue;
      if (usages.some((u) => !u.includes("retentionDays"))) ungated.push(file);
    }
    expect(ungated).toEqual([]);
  });

  it("keeps every exemption real, so the list cannot rot", () => {
    const files = new Set(callSites().keys());
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect(files, `${file} is exempt but no longer renders the picker`).toContain(file);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
