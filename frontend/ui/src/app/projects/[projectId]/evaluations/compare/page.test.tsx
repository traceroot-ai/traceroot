// @vitest-environment jsdom
/**
 * The comparison route keeps the selection in the URL: changing the runs writes them
 * together with the baseline the view was comparing against, so adding an older run
 * never moves the baseline onto it. The case open in the trace panel lives there too, and
 * opening or stepping through cases replaces the history entry instead of adding one. The
 * table's search, filters and sort live there as well, written the same way.
 *
 * Every write starts from the address bar as it is, not as the page last rendered it: in
 * the app a write can follow another before the page re-renders (a filter settling as a
 * case opens), and it must keep what the first one wrote. Here the page renders only when
 * a test says so, so a second write sees the stale render, as it would in the app.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { CompareRunsView } from "@/features/evaluations/views/compare-runs-view";

const PATH = "/projects/p1/evaluations/compare";
/** The query the page last rendered with. */
const rendered = vi.hoisted(() => ({ query: "" }));
const view = vi.hoisted(() => ({ props: undefined as unknown }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(rendered.query),
}));
vi.mock("@/features/evaluations/views/compare-runs-view", () => ({
  CompareRunsView: (props: unknown) => {
    view.props = props;
    return null;
  },
}));

import CompareRunsPage from "./page";

const props = () => view.props as ComponentProps<typeof CompareRunsView>;
const pushState = vi.spyOn(window.history, "pushState");
const replaceState = vi.spyOn(window.history, "replaceState");

/** Open the page at `query`, as a fresh load. */
const mount = (query: string) => {
  window.history.replaceState(null, "", query ? `${PATH}?${query}` : PATH);
  rendered.query = query;
  pushState.mockClear();
  replaceState.mockClear();
  return render(<CompareRunsPage />);
};
/** The address bar's query, decoded (a repeated key keeps its last value). */
const now = () => Object.fromEntries(new URLSearchParams(window.location.search));
/** Render again with the address bar as it now is. */
const rerenderAt = (rerender: (ui: React.ReactElement) => void) => {
  rendered.query = window.location.search.slice(1);
  rerender(<CompareRunsPage />);
};

beforeEach(() => {
  pushState.mockClear();
  replaceState.mockClear();
});
afterEach(() => cleanup());

describe("CompareRunsPage — run selection in the URL", () => {
  it("writes the baseline the view compares against along with the new runs", () => {
    // No baseline in the URL: the view compared against its default, the oldest run "b".
    mount("runs=b,c");
    props().onChangeRuns(["b", "c", "a"], "b");
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(now()).toEqual({ runs: "b,c,a", baseline: "b" });
  });

  it("leaves the baseline out once it is no longer compared", () => {
    mount("runs=a,b,c&baseline=a");
    props().onChangeRuns(["b", "c"], null);
    expect(now()).toEqual({ runs: "b,c" });
    props().onChangeRuns(["b", "c"], "a");
    expect(now()).toEqual({ runs: "b,c" });
  });

  it("keeps the open case when the runs change", () => {
    mount("runs=a,b&case=id:tc_1");
    props().onChangeRuns(["a", "b", "c"], "a");
    expect(now()).toEqual({ runs: "a,b,c", baseline: "a", case: "id:tc_1" });
  });

  it("writes the view's search, filters and sort in the same entry as the runs", () => {
    mount("runs=a,b,c&baseline=a&q=old&f=regressed:quality:b");
    props().onChangeBaseline("b", {
      q: "refund",
      filters: [{ kind: "errors", scorer: null, runId: "any" }],
      sort: { kind: "regression", scorer: "quality", runId: "c" },
    });
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(replaceState).not.toHaveBeenCalled();
    expect(now()).toEqual({
      runs: "a,b,c",
      baseline: "b",
      q: "refund",
      f: "errors:any:any",
      sort: "regression:quality:c",
    });
    props().onChangeRuns(["a", "b"], "b", { q: "", filters: [], sort: { kind: "dataset" } });
    expect(now()).toEqual({ runs: "a,b", baseline: "b" });
  });
});

describe("CompareRunsPage — the open case in the URL", () => {
  it("hands the view the case the URL names", () => {
    mount("runs=a,b&case=id:tc_1");
    expect(props().inspected).toEqual({ caseToken: "id:tc_1", pair: null });
    cleanup();
    mount("runs=a,b");
    expect(props().inspected).toBeNull();
  });

  it("opens a case by replacing the history entry, keeping the rest of the URL", () => {
    mount("runs=a,b&baseline=a");
    props().onInspect({ caseToken: "h:0123456789abcdef", pair: null });
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(now()).toEqual({ runs: "a,b", baseline: "a", case: "h:0123456789abcdef" });
  });

  it("drops the case and its pair from the URL on close", () => {
    mount("runs=a,b&case=id:tc_1&pair=b,a");
    props().onInspect(null);
    expect(now()).toEqual({ runs: "a,b" });
  });

  it("hands the view the pair the URL names, when it names two runs", () => {
    mount("runs=a,b,c&case=id:tc_1&pair=c,b");
    expect(props().inspected).toEqual({ caseToken: "id:tc_1", pair: ["c", "b"] });
    cleanup();
    mount("runs=a,b,c&case=id:tc_1&pair=c");
    expect(props().inspected).toEqual({ caseToken: "id:tc_1", pair: null });
  });

  it("writes the pair with the case", () => {
    mount("runs=a,b&baseline=a");
    props().onInspect({ caseToken: "id:tc_1", pair: ["b", "a"] });
    expect(now()).toEqual({ runs: "a,b", baseline: "a", case: "id:tc_1", pair: "b,a" });
  });

  it("drops the pair once one of its runs leaves, keeping the case", () => {
    mount("runs=a,b,c&baseline=a&case=id:tc_1&pair=a,c");
    props().onChangeRuns(["a", "b"], "a");
    expect(now()).toEqual({ runs: "a,b", baseline: "a", case: "id:tc_1" });
  });

  it("keeps the pair while both of its runs stay", () => {
    mount("runs=a,b&baseline=a&case=id:tc_1&pair=a,b");
    props().onChangeRuns(["a", "b", "c"], "a");
    expect(now()).toEqual({ runs: "a,b,c", baseline: "a", case: "id:tc_1", pair: "a,b" });
  });

  it("drops a pair on the baseline being replaced, so the trace panel follows the new one", () => {
    // No baseline in the URL: the view names the one it compared against.
    mount("runs=a,b,c&case=id:tc_1&pair=a,c");
    props().onChangeBaseline("b", undefined, "a");
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(now()).toEqual({ runs: "a,b,c", baseline: "b", case: "id:tc_1" });
  });

  it("keeps a pair picked in the trace panel when the baseline changes", () => {
    mount("runs=a,b,c&baseline=a&case=id:tc_1&pair=c,b");
    props().onChangeBaseline("b", undefined, "a");
    expect(now()).toEqual({ runs: "a,b,c", baseline: "b", case: "id:tc_1", pair: "c,b" });
  });
});

describe("CompareRunsPage — the table's search, filters and sort in the URL", () => {
  const FULL =
    "runs=a,b&baseline=a&q=refund&f=regressed:quality:b&sort=regression:quality:b" +
    "&case=id:tc_1&pair=a,b";
  const REGRESSED = { kind: "regressed", scorer: "quality", runId: "b" } as const;
  const ERRORS = { kind: "errors", scorer: null, runId: "any" } as const;
  const DATASET = { kind: "dataset" } as const;

  it("hands the view the search, filters and sort the URL names", () => {
    mount(FULL);
    expect(props().analysis).toEqual({
      q: "refund",
      filters: [REGRESSED],
      sort: { kind: "regression", scorer: "quality", runId: "b" },
    });
    expect(props().inspected).toEqual({ caseToken: "id:tc_1", pair: ["a", "b"] });
    cleanup();
    mount("runs=a,b");
    expect(props().analysis).toEqual({ q: "", filters: [], sort: DATASET });
  });

  it("writes them by replacing the history entry, keeping the rest of the URL", () => {
    mount("runs=a,b&baseline=a&case=id:tc_1&pair=a,b&from=run-detail");
    props().onChangeAnalysis?.({
      q: "refund",
      filters: [REGRESSED, ERRORS],
      sort: { kind: "regression", scorer: "quality", runId: "b" },
    });
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(window.location.search).getAll("f")).toEqual([
      "regressed:quality:b",
      "errors:any:any",
    ]);
    expect(now()).toEqual({
      runs: "a,b",
      baseline: "a",
      q: "refund",
      f: "errors:any:any",
      sort: "regression:quality:b",
      case: "id:tc_1",
      pair: "a,b",
      from: "run-detail",
    });
  });

  it("keeps the search, filters and sort when the runs or the open case change", () => {
    mount(FULL);
    props().onChangeRuns(["a", "b", "c"], "a");
    expect(now()).toMatchObject({ q: "refund", f: "regressed:quality:b" });
    props().onInspect(null);
    expect(now()).toEqual({
      runs: "a,b,c",
      baseline: "a",
      q: "refund",
      f: "regressed:quality:b",
      sort: "regression:quality:b",
    });
  });

  it("keeps parameters it doesn't know on every write", () => {
    mount("runs=a,b&from=run-detail");
    props().onChangeBaseline("b");
    expect(now()).toEqual({ runs: "a,b", baseline: "b", from: "run-detail" });
    props().onInspect({ caseToken: "id:tc_1", pair: null });
    expect(now()).toEqual({ runs: "a,b", baseline: "b", case: "id:tc_1", from: "run-detail" });
  });
});

describe("CompareRunsPage — writes that follow each other before a render", () => {
  it("keeps a filter that settles just before a case opens", () => {
    mount("runs=a,b&baseline=a");
    const { onChangeAnalysis, onInspect } = props();
    onChangeAnalysis?.({
      q: "",
      filters: [{ kind: "errors", scorer: "any", runId: "any" }],
      sort: { kind: "dataset" },
    });
    onInspect({ caseToken: "id:tc_1", pair: ["a", "b"] });
    expect(now()).toEqual({
      runs: "a,b",
      baseline: "a",
      f: "errors:any:any",
      case: "id:tc_1",
      pair: "a,b",
    });
  });

  it("keeps the open case when a filter settles just after it opens", () => {
    mount("runs=a,b&baseline=a");
    const { onChangeAnalysis, onInspect } = props();
    onInspect({ caseToken: "id:tc_1", pair: ["a", "b"] });
    onChangeAnalysis?.({
      q: "",
      filters: [{ kind: "errors", scorer: "any", runId: "any" }],
      sort: { kind: "dataset" },
    });
    expect(now()).toMatchObject({ case: "id:tc_1", pair: "a,b", f: "errors:any:any" });
  });

  it("keeps a new baseline when a search settles just after it", () => {
    mount("runs=a,b,c&baseline=a");
    const { onChangeBaseline, onChangeAnalysis } = props();
    onChangeBaseline("b");
    onChangeAnalysis?.({ q: "refund", filters: [], sort: { kind: "dataset" } });
    expect(now()).toEqual({ runs: "a,b,c", baseline: "b", q: "refund" });
  });
});

describe("CompareRunsPage — back and forward", () => {
  const popstate = () =>
    new Promise<void>((resolve) =>
      window.addEventListener("popstate", () => resolve(), { once: true }),
    );

  it("restores what each history entry held", async () => {
    const { rerender } = mount("runs=a,b,c&baseline=a");
    props().onChangeAnalysis?.({ q: "refund", filters: [], sort: { kind: "dataset" } });
    props().onChangeBaseline("b");
    rerenderAt(rerender);
    expect(props().baselineId).toBe("b");

    const back = popstate();
    window.history.back();
    await back;
    rerenderAt(rerender);
    expect(props().baselineId).toBe("a");
    expect(props().analysis?.q).toBe("refund");

    const forward = popstate();
    window.history.forward();
    await forward;
    rerenderAt(rerender);
    expect(props().baselineId).toBe("b");
    expect(props().analysis?.q).toBe("refund");
  });
});
