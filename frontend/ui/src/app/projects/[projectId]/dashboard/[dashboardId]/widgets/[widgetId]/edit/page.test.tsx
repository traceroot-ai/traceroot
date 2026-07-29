// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import EditWidgetPage from "./page";

const mounted = vi.fn();
vi.mock("@/features/dashboards/components/WidgetBuilderPage", () => ({
  WidgetBuilderPage: (props: { projectId: string; dashboardId: string; widgetId?: string }) => {
    // Fires once per mount (not per update) — how the tests below tell a
    // remounted builder from a prop-updated one.
    useEffect(() => {
      mounted(props.widgetId);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div>{`builder-${props.projectId}-${props.dashboardId}-${props.widgetId}`}</div>;
  },
}));

let widgetId = "w1";
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", dashboardId: "d1", widgetId }),
}));

describe("EditWidgetPage", () => {
  it("passes the route params through and remounts the builder per widget", () => {
    const { rerender } = render(<EditWidgetPage />);
    expect(screen.getByText("builder-p1-d1-w1")).toBeTruthy();

    // A widgetId change without a segment remount (App Router keeps the
    // subtree on same-route param changes) must reset the builder: it
    // hydrates its draft once behind a flag, so a reused instance would show
    // the previous widget's draft. The key makes it a fresh mount.
    widgetId = "w2";
    rerender(<EditWidgetPage />);
    expect(screen.getByText("builder-p1-d1-w2")).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(mounted).toHaveBeenNthCalledWith(1, "w1");
    expect(mounted).toHaveBeenNthCalledWith(2, "w2");
  });
});
