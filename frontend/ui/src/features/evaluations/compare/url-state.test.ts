import { describe, expect, it } from "vitest";
import { NO_ANALYSIS, type CaseFilter } from "./filters";
import { parseCompareUrl, serializeCompareUrl, type CompareUrlState } from "./url-state";

const EMPTY: CompareUrlState = {
  runs: [],
  baseline: null,
  ...NO_ANALYSIS,
};

const parse = (query: string) => parseCompareUrl(new URLSearchParams(query));
/** Serialize, then read it back the way the browser hands it over. */
const roundTrip = (state: CompareUrlState, keep?: string) =>
  parse(serializeCompareUrl(state, keep === undefined ? undefined : new URLSearchParams(keep)));

describe("parseCompareUrl", () => {
  it("reads every part of the comparison", () => {
    expect(
      parse(
        "runs=a,b,c&baseline=b&q=refund&f=regressed:quality:c&f=errors:any:any" +
          "&sort=regression:quality:c",
      ),
    ).toEqual({
      runs: ["a", "b", "c"],
      baseline: "b",
      q: "refund",
      filters: [
        { kind: "regressed", scorer: "quality", runId: "c" },
        { kind: "errors", scorer: null, runId: "any" },
      ],
      sort: { kind: "regression", scorer: "quality", runId: "c" },
    });
  });

  it("reads each run once", () => {
    expect(parse("runs=a,b,a,b").runs).toEqual(["a", "b"]);
  });

  it("reads an empty URL as the default view", () => {
    expect(parse("")).toEqual(EMPTY);
    expect(parse("runs=&baseline=&q=")).toEqual(EMPTY);
  });

  it("drops filters and sorts it can't read", () => {
    const { filters, sort } = parse(
      "f=bogus:quality:a&f=regressed&f=regressed:quality&f=regressed::a&f=regressed:quality:" +
        "&f=regressed:%25E0%25A4%25A:a&sort=dataset:quality:a",
    );
    expect(filters).toEqual([]);
    expect(sort).toEqual({ kind: "dataset" });
    // A regression sort names one scorer and one run.
    expect(parse("sort=regression:quality:any").sort).toEqual({ kind: "dataset" });
    expect(parse("sort=regression:any:a").sort).toEqual({ kind: "dataset" });
  });

  it("reads a hand-written scorer name with colons, splitting on the first and last", () => {
    expect(parse("f=regressed:ns:quality:run-2").filters).toEqual([
      { kind: "regressed", scorer: "ns:quality", runId: "run-2" },
    ]);
    expect(parse("sort=regression:ns:quality:run-2").sort).toEqual({
      kind: "regression",
      scorer: "ns:quality",
      runId: "run-2",
    });
  });

  it("keeps one of each filter", () => {
    expect(parse("f=regressed:quality:a&f=regressed:quality:a").filters).toHaveLength(1);
    // An unmatched filter has no scorer, so two that name different ones are the same.
    expect(parse("f=unmatched:quality:a&f=unmatched:any:a").filters).toEqual([
      { kind: "unmatched", scorer: null, runId: "a" },
    ]);
  });
});

describe("serializeCompareUrl", () => {
  it("writes nothing for the default view", () => {
    expect(serializeCompareUrl(EMPTY)).toBe("");
  });

  it("keeps colons and commas readable", () => {
    expect(
      serializeCompareUrl({
        ...EMPTY,
        runs: ["a", "b"],
        baseline: "a",
        q: "refund",
        filters: [{ kind: "regressed", scorer: "quality", runId: "b" }],
        sort: { kind: "regression", scorer: "quality", runId: "b" },
      }),
    ).toBe("runs=a,b&baseline=a&q=refund&f=regressed:quality:b&sort=regression:quality:b");
  });

  it("leaves a blank search out", () => {
    expect(serializeCompareUrl({ ...EMPTY, q: "   " })).toBe("");
    expect(serializeCompareUrl({ ...EMPTY, q: " refund " })).toBe("q=refund");
  });

  it("keeps the parameters it doesn't own, in their order, and replaces the ones it does", () => {
    const qs = serializeCompareUrl(
      { ...EMPTY, runs: ["a", "b"], q: "new" },
      new URLSearchParams("utm=x&q=old&f=errors:any:any&tag=1&tag=2"),
    );
    expect(qs).toBe("runs=a,b&q=new&utm=x&tag=1&tag=2");
  });

  it("round-trips scorer names and searches with awkward characters", () => {
    const names = [
      "ns:quality",
      "a:b:c",
      "50% done",
      "a,b",
      "x&y=z",
      "#1 + 2?",
      "answer relevance",
      "质量",
      "%3A",
      "trailing:",
      ":leading",
    ];
    for (const name of names) {
      const filters: CaseFilter[] = [
        { kind: "changed", scorer: name, runId: "run:2" },
        { kind: "errors", scorer: null, runId: "any" },
      ];
      const state: CompareUrlState = {
        ...EMPTY,
        runs: ["r1", "run:2"],
        q: name,
        filters,
        sort: { kind: "regression", scorer: name, runId: "run:2" },
      };
      expect(roundTrip(state)).toEqual(state);
    }
  });

  it("round-trips every filter kind", () => {
    const filters: CaseFilter[] = [
      { kind: "improved", scorer: "quality", runId: "b" },
      { kind: "regressed", scorer: null, runId: "c" },
      { kind: "changed", scorer: "route", runId: "any" },
      { kind: "errors", scorer: "quality", runId: "a" },
      { kind: "unmatched", scorer: null, runId: "b" },
    ];
    expect(roundTrip({ ...EMPTY, filters }).filters).toEqual(filters);
  });

  it("tells a metric named any from any metric, and still reads `any` as any metric", () => {
    const sort = { kind: "regression", scorer: "any", runId: "b" } as const;
    expect(roundTrip({ ...EMPTY, sort }).sort).toEqual(sort);
    const filters: CaseFilter[] = [
      { kind: "regressed", scorer: "any", runId: "b" },
      { kind: "regressed", scorer: null, runId: "b" },
    ];
    expect(roundTrip({ ...EMPTY, filters }).filters).toEqual(filters);
    // Any metric is still written, and read, as it always was.
    expect(serializeCompareUrl({ ...EMPTY, filters: [filters[1]] })).toBe("f=regressed:any:b");
    expect(parse("f=errors:any:any").filters).toEqual([
      { kind: "errors", scorer: null, runId: "any" },
    ]);
  });

  it("keeps unknown parameters through a round trip", () => {
    const qs = serializeCompareUrl(
      { ...EMPTY, runs: ["a", "b"] },
      new URLSearchParams("from=run-detail&note=a%3Ab%26c"),
    );
    const params = new URLSearchParams(qs);
    expect(params.get("from")).toBe("run-detail");
    expect(params.get("note")).toBe("a:b&c");
  });
});
