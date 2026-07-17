// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardDetail, DashboardSummary, Widget } from "@/features/dashboards/types";
import DashboardDetailPage from "./page";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// jsdom doesn't implement ResizeObserver, which DashboardDetailPage uses to
// track the grid body's width.
(global as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1", dashboardId: "d1" }),
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/dashboard/d1",
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));

const createDashboard: {
  mutate: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  isPending: boolean;
  error: Error | null;
} = { mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null };
const updateLayout: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null } =
  {
    mutate: vi.fn(),
    isPending: false,
    error: null,
  };
const createWidget: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null } =
  {
    mutate: vi.fn(),
    isPending: false,
    error: null,
  };
const removeWidget: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null } =
  {
    mutate: vi.fn(),
    isPending: false,
    error: null,
  };
const removeDashboard: {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
} = { mutate: vi.fn(), isPending: false, isError: false, error: null };

vi.mock("@/features/dashboards/hooks/use-dashboards", () => ({
  useDashboards: vi.fn(),
  useDashboard: vi.fn(),
  useDashboardMutations: () => ({
    createDashboard,
    updateLayout,
    createWidget,
    removeWidget,
    removeDashboard,
  }),
}));

let lastGridProps: {
  widgets: Widget[];
  layout: unknown;
  range: unknown;
  readOnly?: boolean;
  onEdit: (w: Widget) => void;
  onDuplicate: (w: Widget) => void;
  onDelete: (w: Widget) => void;
} | null = null;

vi.mock("@/features/dashboards/components/DashboardGrid", () => ({
  DashboardGrid: (props: {
    widgets: Widget[];
    layout: unknown;
    range: unknown;
    readOnly?: boolean;
    onEdit: (w: Widget) => void;
    onDuplicate: (w: Widget) => void;
    onDelete: (w: Widget) => void;
  }) => {
    lastGridProps = props;
    return (
      <div data-testid="dashboard-grid">
        {props.widgets.map((w) => (
          <div key={w.id}>
            <button onClick={() => props.onEdit(w)}>{`edit-${w.id}`}</button>
            <button onClick={() => props.onDuplicate(w)}>{`duplicate-${w.id}`}</button>
            <button onClick={() => props.onDelete(w)}>{`delete-${w.id}`}</button>
          </div>
        ))}
      </div>
    );
  },
}));

import { useDashboard, useDashboards } from "@/features/dashboards/hooks/use-dashboards";

// The rendered dashboard (d1) is deliberately non-default: the default one is
// read-only, which the dedicated tests below cover.
const DASH_A: DashboardSummary = {
  id: "d1",
  name: "Custom",
  description: null,
  isDefault: false,
  updateTime: "",
};
const DASH_B: DashboardSummary = {
  id: "d2",
  name: "Overview",
  description: null,
  isDefault: true,
  updateTime: "",
};

const WIDGET: Widget = {
  id: "w1",
  dashboardId: "d1",
  title: "Cost",
  type: "query",
  spec: { view: "spans" },
  displayConfig: {},
};

function mockLists(dashboards: DashboardSummary[] | undefined) {
  vi.mocked(useDashboards).mockReturnValue({
    data: dashboards,
  } as ReturnType<typeof useDashboards>);
}

function mockDetail(data: DashboardDetail | undefined, error: unknown = null) {
  vi.mocked(useDashboard).mockReturnValue({ data, error } as ReturnType<typeof useDashboard>);
}

function renderPage() {
  const queryClient = new QueryClient();
  const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
  render(
    <QueryClientProvider client={queryClient}>
      <DashboardDetailPage />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

describe("DashboardDetailPage", () => {
  afterEach(cleanup);
  beforeEach(() => {
    push.mockReset();
    replace.mockReset();
    createDashboard.mutate.mockReset();
    updateLayout.mutate.mockReset();
    createWidget.mutate.mockReset();
    removeWidget.mutate.mockReset();
    removeDashboard.mutate.mockReset();
    removeDashboard.isError = false;
    removeDashboard.error = null;
    lastGridProps = null;
    mockLists([DASH_A, DASH_B]);
    mockDetail({ ...DASH_A, layout: [], widgets: [] });
  });

  it("renders dashboard tabs with the default marked and the current one highlighted", () => {
    renderPage();

    const customTab = screen.getByRole("link", { name: "Custom" });
    expect(customTab.textContent).not.toContain("⌂");
    expect(customTab.getAttribute("aria-current")).toBe("page");

    const overviewTab = screen.getByRole("link", { name: /Overview/ });
    expect(overviewTab.textContent).toContain("⌂");
    expect(overviewTab.getAttribute("aria-current")).toBeNull();

    expect(screen.getByRole("button", { name: "＋ new" })).toBeTruthy();
  });

  it("keeps header controls outside the scrollable tab strip when dashboards pile up", () => {
    mockLists(
      Array.from({ length: 30 }, (_, i) => ({ ...DASH_A, id: `d${i + 1}`, name: `Dash ${i + 1}` })),
    );
    mockDetail({ ...DASH_A, layout: [], widgets: [WIDGET] });
    renderPage();

    // All tabs render inside one horizontally scrollable strip…
    const strip = screen.getByRole("link", { name: "Dash 30" }).parentElement!;
    expect(strip.className).toContain("overflow-x-auto");
    expect(strip.querySelectorAll("a")).toHaveLength(30);

    // …while ＋ new, the date filter, and the widget controls live outside it,
    // so an ever-growing dashboard list can never push them off screen.
    const newButton = screen.getByRole("button", { name: "＋ new" });
    expect(strip.contains(newButton)).toBe(false);
    const dateFilterButton = screen.getByRole("button", { name: "Last 24 hours" });
    expect(strip.contains(dateFilterButton)).toBe(false);
    const createWidget = screen.getByRole("button", { name: "＋ Create widget" });
    expect(strip.contains(createWidget)).toBe(false);
  });

  it("restores the tab strip scroll position across the remount a tab click causes", () => {
    mockLists(
      Array.from({ length: 30 }, (_, i) => ({ ...DASH_A, id: `d${i + 1}`, name: `Dash ${i + 1}` })),
    );
    mockDetail({ ...DASH_A, layout: [], widgets: [WIDGET] });
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient()}>
        <DashboardDetailPage />
      </QueryClientProvider>,
    );

    // The user scrolls deep into the strip… (the recorded position lives in a
    // module-scope Map, so it deliberately persists for the rest of this test
    // file — later mounts restore it, which nothing else asserts on)
    const strip = screen.getByRole("link", { name: "Dash 30" }).parentElement!;
    strip.scrollLeft = 480;
    fireEvent.scroll(strip);

    // …then clicks a tab, which navigates and remounts the whole page.
    unmount();
    renderPage();

    const remounted = screen.getByRole("link", { name: "Dash 30" }).parentElement!;
    expect(remounted.scrollLeft).toBe(480);
  });

  it("opens the create-dashboard dialog and cancelling it does not create", () => {
    renderPage();

    expect(screen.queryByText("Create Dashboard")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "＋ new" }));
    expect(screen.getByText("Create Dashboard")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(createDashboard.mutate).not.toHaveBeenCalled();
  });

  it("creates a dashboard from the dialog and navigates to it on success", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "＋ new" }));
    fireEvent.change(screen.getByPlaceholderText("Dashboard name"), {
      target: { value: "New dash" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createDashboard.mutate).toHaveBeenCalledTimes(1);
    const [payload, options] = createDashboard.mutate.mock.calls[0];
    expect(payload).toEqual({ name: "New dash" });

    options.onSuccess({ dashboard: { id: "d9" } });
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d9");
  });

  it("shows the active range preset label", () => {
    renderPage();
    // Same default as the trace list (DEFAULT_DATE_FILTER = 24 hours).
    expect(screen.getByRole("button", { name: "Last 24 hours" })).toBeTruthy();
  });

  it("pushes to the widgets/new route from the header create-widget button", () => {
    renderPage();
    // The empty-state CTA renders the same label, so target the header button
    // (the first one in document order) specifically.
    const [headerButton] = screen.getAllByRole("button", { name: "＋ Create widget" });
    fireEvent.click(headerButton);
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d1/widgets/new");
  });

  it("pushes to the widgets/new route from the empty-state CTA when there are no widgets", () => {
    renderPage();
    expect(screen.getByText("No widgets yet.")).toBeTruthy();

    const buttons = screen.getAllByRole("button", { name: "＋ Create widget" });
    expect(buttons.length).toBe(2);

    fireEvent.click(buttons[1]);
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d1/widgets/new");
  });

  it("marks the grid read-only and hides both create-widget buttons on the default dashboard", () => {
    mockDetail({ ...DASH_B, layout: [], widgets: [WIDGET] });
    renderPage();

    expect(screen.queryByRole("button", { name: "＋ Create widget" })).toBeNull();
    expect(lastGridProps?.readOnly).toBe(true);
  });

  it("keeps the grid editable on a non-default dashboard", () => {
    mockDetail({ ...DASH_A, layout: [], widgets: [WIDGET] });
    renderPage();

    expect(screen.getAllByRole("button", { name: "＋ Create widget" }).length).toBe(1);
    expect(lastGridProps?.readOnly).toBe(false);
  });

  it("deletes the dashboard through the confirm dialog and navigates to the index", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete dashboard" }));
    expect(screen.getByText("Delete Dashboard")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(removeDashboard.mutate).toHaveBeenCalledTimes(1);
    const [id, options] = removeDashboard.mutate.mock.calls[0];
    expect(id).toBe("d1");

    options.onSuccess();
    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard");
  });

  it("shows the delete error inside the dialog when the mutation fails", () => {
    removeDashboard.isError = true;
    removeDashboard.error = new Error("boom");
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete dashboard" }));
    expect(screen.getByText("boom")).toBeTruthy();
  });

  it("cancelling the delete dialog does not delete", () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Delete dashboard" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(removeDashboard.mutate).not.toHaveBeenCalled();
  });

  it("hides the delete button on the read-only default dashboard", () => {
    mockDetail({ ...DASH_B, layout: [], widgets: [] });
    renderPage();
    expect(screen.queryByRole("button", { name: "Delete dashboard" })).toBeNull();
  });

  it("redirects to the dashboard index and invalidates the list cache when the dashboard is gone", () => {
    mockDetail(undefined, new Error("Dashboard not found"));
    const { invalidateSpy } = renderPage();

    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "p1"] });
  });

  it("stays put and shows a failure notice on a transient load error", () => {
    mockDetail(undefined, new Error("API error: 503"));
    const { invalidateSpy } = renderPage();

    expect(replace).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(screen.getByText(/Failed to load the dashboard/)).toBeTruthy();
  });

  it("keeps rendering the cached dashboard when a background poll fails", () => {
    mockDetail(
      { ...DASH_A, widgets: [WIDGET], layout: [{ i: "w1", x: 0, y: 0, w: 4, h: 4 }] },
      new Error("API error: 503"),
    );
    renderPage();

    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/Failed to load the dashboard/)).toBeNull();
    expect(lastGridProps?.widgets).toEqual([WIDGET]);
  });

  it("hides edit controls while the dashboard is still loading", () => {
    mockDetail(undefined);
    renderPage();

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "＋ Create widget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete dashboard" })).toBeNull();
  });

  it("passes widgets, layout and range to the grid and wires edit/duplicate/delete", () => {
    mockDetail({
      ...DASH_A,
      layout: [{ i: "w1", x: 0, y: 0, w: 4, h: 4 }],
      widgets: [WIDGET],
    });
    renderPage();

    expect(screen.queryByText("No widgets yet.")).toBeNull();
    expect(lastGridProps?.widgets).toEqual([WIDGET]);
    expect(lastGridProps?.layout).toEqual([{ i: "w1", x: 0, y: 0, w: 4, h: 4 }]);
    expect(lastGridProps?.range).toHaveProperty("start");
    expect(lastGridProps?.range).toHaveProperty("end");

    fireEvent.click(screen.getByRole("button", { name: "duplicate-w1" }));
    expect(createWidget.mutate).toHaveBeenCalledWith({
      title: "Cost (copy)",
      type: "query",
      spec: WIDGET.spec,
      // A duplicate carries the display settings too, not just the query.
      displayConfig: WIDGET.displayConfig,
    });

    fireEvent.click(screen.getByRole("button", { name: "delete-w1" }));
    expect(removeWidget.mutate).toHaveBeenCalledWith("w1");

    fireEvent.click(screen.getByRole("button", { name: "edit-w1" }));
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d1/widgets/w1/edit");
  });
});
