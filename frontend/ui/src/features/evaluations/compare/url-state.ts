/**
 * The comparison page's URL, which holds everything needed to land on the same view
 * again: the runs and baseline, and the table's search, filters and sort.
 *
 *   ?runs=<id,id,…>&baseline=<id>&q=<search>
 *    &f=<kind>:<scorer|any>:<run id|any>      (once per filter)
 *    &sort=regression:<scorer>:<run id>
 *
 * A filter's or sort's scorer and run are percent-encoded on their own, so a scorer name
 * with a colon survives; one written by hand is split on its first and last colon.
 * Anything that can't be read is dropped, and parameters this page doesn't own are kept.
 */
import { DATASET_ORDER, isFilterKind, sameFilter, type CaseFilter, type CaseSort } from "./filters";

export interface CompareUrlState {
  runs: string[];
  baseline: string | null;
  /** The table's search. */
  q: string;
  filters: CaseFilter[];
  sort: CaseSort;
}

const OWNED = new Set(["runs", "baseline", "q", "f", "sort"]);

/** The ids in a comma list, each once (a run listed twice is still one run). */
const ids = (text: string | null) => [
  ...new Set(
    (text ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

/** `kind:scorer:run`, split on the first and last colon, scorer and run decoded; null
 *  unless all three parts are there. */
function readTriple(text: string): [string, string, string] | null {
  const first = text.indexOf(":");
  const last = text.lastIndexOf(":");
  if (first <= 0 || last <= first + 1 || last === text.length - 1) return null;
  try {
    return [
      text.slice(0, first),
      decodeURIComponent(text.slice(first + 1, last)),
      decodeURIComponent(text.slice(last + 1)),
    ];
  } catch {
    return null;
  }
}

const writeTriple = (head: string, scorer: string, runId: string) =>
  `${head}:${encodeURIComponent(scorer)}:${encodeURIComponent(runId)}`;

function readFilter(text: string): CaseFilter | null {
  const parts = readTriple(text);
  if (!parts || !isFilterKind(parts[0])) return null;
  // Whether a run has the case doesn't depend on a scorer.
  return { kind: parts[0], scorer: parts[0] === "unmatched" ? "any" : parts[1], runId: parts[2] };
}

function readSort(text: string | null): CaseSort {
  const parts = text ? readTriple(text) : null;
  if (!parts || parts[0] !== "regression" || parts[1] === "any" || parts[2] === "any") {
    return DATASET_ORDER;
  }
  return { kind: "regression", scorer: parts[1], runId: parts[2] };
}

export function parseCompareUrl(params: URLSearchParams): CompareUrlState {
  const filters: CaseFilter[] = [];
  for (const text of params.getAll("f")) {
    const filter = readFilter(text);
    if (filter && !filters.some((f) => sameFilter(f, filter))) filters.push(filter);
  }
  return {
    runs: ids(params.get("runs")),
    baseline: params.get("baseline") || null,
    q: params.get("q") ?? "",
    filters,
    sort: readSort(params.get("sort")),
  };
}

// Colons and commas are fine in a query and keep the URL readable; the parts of a filter
// that need them encoded already are.
const encodeValue = (value: string) =>
  encodeURIComponent(value).replace(/%3A/gi, ":").replace(/%2C/gi, ",");

/** The query string for `state`, without the `?`: empty for the default view. The
 *  parameters of `current` this page doesn't own follow, in their order. */
export function serializeCompareUrl(state: CompareUrlState, current?: URLSearchParams): string {
  const entries: [string, string][] = [];
  if (state.runs.length) entries.push(["runs", state.runs.join(",")]);
  if (state.baseline) entries.push(["baseline", state.baseline]);
  const q = state.q.trim();
  if (q) entries.push(["q", q]);
  for (const f of state.filters) entries.push(["f", writeTriple(f.kind, f.scorer, f.runId)]);
  if (state.sort.kind === "regression") {
    entries.push(["sort", writeTriple("regression", state.sort.scorer, state.sort.runId)]);
  }
  current?.forEach((value, key) => {
    if (!OWNED.has(key)) entries.push([key, value]);
  });
  return entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeValue(v)}`).join("&");
}
