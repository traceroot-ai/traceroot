/**
 * Route-reachability guard.
 *
 * Every `app/**​/page.tsx` route must be reachable from somewhere in the app, or be on
 * the allowlist below WITH a stated reason. This exists because a page can render, be
 * shareable, and survive reload while nothing ever links to it — an orphan the type
 * checker and every render test stay green on (the `/evaluations/compare` page was
 * exactly this before it was removed).
 *
 * Matching is deliberately path-anchored, not literal-`href`-only: navigation targets
 * are composed from template literals (`/projects/${projectId}/…`) and nav-config
 * objects, so a naive `href="…"` scan false-positives on real links. We instead search
 * the whole source tree for the route's full path as the START of a URL literal
 * (preceded by a quote/backtick/paren), with dynamic `[param]` segments allowed to be
 * any non-slash run. Anchoring to the leading quote is what distinguishes a PAGE URL
 * (`"/projects/…/evaluations/compare"`) from the same-named API URL
 * (`"/api/projects/…/evaluations/compare"`), whose literal begins with `/api`.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const APP = join(SRC, "app");

/**
 * Routes with no in-app entry point ON PURPOSE. Each needs a reason: adding a route here
 * is the deliberate act the guard forces you to make (and justify) instead of a page
 * silently rotting.
 */
const ALLOWLIST: Record<string, string> = {
  "/auth/error": "Entered by an auth redirect (NextAuth error callback), never linked.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** Directory segments of a page route, with route groups `(…)` stripped. */
function routeSegments(pageFile: string): string[] {
  return relative(APP, pageFile)
    .split(sep)
    .slice(0, -1) // drop the `page.tsx` filename
    .filter((s) => !(s.startsWith("(") && s.endsWith(")"))); // route groups are invisible in the URL
}

function routePath(segments: string[]): string {
  return "/" + segments.join("/");
}

/** A regex that matches this route's path at the start of a URL literal. Dynamic
 *  `[param]` / `[[...param]]` segments become "any run of non-slash, non-quote chars"
 *  so a `${…}` interpolation (or a concrete id) matches. */
function urlLiteralRegex(segments: string[]): RegExp {
  const body = segments
    .map((seg) =>
      seg.startsWith("[")
        ? "[^/\"'`)]+"
        : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("/");
  // Leading quote/backtick/paren + `/` anchors the match to the START of a URL literal,
  // so `/api/projects/…` (literal begins with `/api`) never satisfies a page route.
  return new RegExp("[\"'`(]/" + body + "(?![A-Za-z0-9_-])");
}

/** A nav tab often links its leaf RELATIVELY (`href: "members"`), so the full path never
 *  appears as one literal. Match the leaf as a quoted `href` value — a navigation
 *  context, not just any occurrence of the word (so a bare `"compare"` string elsewhere
 *  can't make a genuinely-orphaned page look reachable). */
function relativeHrefRegex(leaf: string): RegExp {
  const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("href[:=]\\s*[\"'`]" + esc + "[\"'`]");
}

const pageFiles = walk(APP).filter((f) => f.endsWith(`${sep}page.tsx`));
// The corpus every route is searched against: all source except generated output and
// THIS guard file (its ALLOWLIST + comments mention route paths, which would otherwise
// self-satisfy the match). A route's OWN directory is excluded per-route below, so a
// page self-referencing (e.g. rewriting its own query string) never counts either.
const corpus = walk(SRC).filter(
  (f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(`${sep}route-reachability.test.ts`),
);
const fileText = new Map(corpus.map((f) => [f, readFileSync(f, "utf8")]));

describe("route reachability", () => {
  it("finds at least the routes we expect (guard is actually scanning)", () => {
    // A floor so a broken glob can't make the whole suite vacuously pass.
    expect(pageFiles.length).toBeGreaterThan(10);
  });

  for (const pageFile of pageFiles) {
    const segments = routeSegments(pageFile);
    const path = routePath(segments);
    const pageDir = pageFile.slice(0, pageFile.lastIndexOf(sep));

    it(`${path} is reachable or explicitly allowlisted`, () => {
      if (path === "/") return; // the app root is reachable by definition
      const regex = urlLiteralRegex(segments);
      const leaf = segments[segments.length - 1] ?? "";
      const leafRegex = leaf && !leaf.startsWith("[") ? relativeHrefRegex(leaf) : null;
      const reachable = corpus.some((f) => {
        if (f.startsWith(pageDir + sep) || f === pageFile) return false; // never self-reach
        const text = fileText.get(f)!;
        return regex.test(text) || (leafRegex !== null && leafRegex.test(text));
      });
      const allowed = path in ALLOWLIST;

      if (!reachable && !allowed) {
        throw new Error(
          `Route ${path} has no in-app entry point. Either add navigation to it, or ` +
            `add it to ALLOWLIST in this file with a reason (e.g. "entered by redirect").`,
        );
      }
      // An allowlisted route that became reachable should leave the allowlist, so the
      // list stays a true record of deliberately-unlinked pages.
      if (allowed && reachable) {
        throw new Error(
          `Route ${path} is on the ALLOWLIST but IS now reachable — remove it from the allowlist.`,
        );
      }
      expect(true).toBe(true);
    });
  }
});
