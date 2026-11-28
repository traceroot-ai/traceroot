// @vitest-environment jsdom
/**
 * The comparison route keeps the selection in the URL: changing the runs writes them
 * together with the baseline the view was comparing against, so adding an older run
 * never moves the baseline onto it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { CompareRunsView } from "@/features/evaluations/views/compare-runs-view";

const url = vi.hoisted(() => ({ query: "" }));
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const view = vi.hoisted(() => ({ props: undefined as unknown }));

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useSearchParams: () => new URLSearchParams(url.query),
  useRouter: () => navigation,
}));
vi.mock("@/features/evaluations/views/compare-runs-view", () => ({
  CompareRunsView: (props: unknown) => {
    view.props = props;
    return null;
  },
}));

import CompareRunsPage from "./page";

const props = () => view.props as ComponentProps<typeof CompareRunsView>;
/** The query the last navigation wrote, decoded. */
const pushed = () => {
  const href = navigation.push.mock.lastCall?.[0] as string;
  return Object.fromEntries(new URLSearchParams(href.split("?")[1]));
};

afterEach(() => {
  cleanup();
  navigation.push.mockReset();
});

describe("CompareRunsPage — run selection in the URL", () => {
  it("writes the baseline the view compares against along with the new runs", () => {
    // No baseline in the URL: the view compared against its default, the oldest run "b".
    url.query = "runs=b,c";
    render(<CompareRunsPage />);
    props().onChangeRuns(["b", "c", "a"], "b");
    expect(pushed()).toEqual({ runs: "b,c,a", baseline: "b" });
  });

  it("leaves the baseline out once it is no longer compared", () => {
    url.query = "runs=a,b,c&baseline=a";
    render(<CompareRunsPage />);
    props().onChangeRuns(["b", "c"], null);
    expect(pushed()).toEqual({ runs: "b,c" });
    props().onChangeRuns(["b", "c"], "a");
    expect(pushed()).toEqual({ runs: "b,c" });
  });
});
