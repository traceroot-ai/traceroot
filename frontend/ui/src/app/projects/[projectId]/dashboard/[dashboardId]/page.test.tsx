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

const updateLayout: { mutate: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null } =
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

vi.mock("@/features/dashboards/hooks/use-dashboards", () => ({
  useDashboard: vi.fn(),
  useDashboardMutations: () => ({
    updateLayout,
    removeWidget,
  }),
}));

let lastGridProps: {
  widgets: Widget[];
  layout: unknown;
  range: unknown;
  readOnly?: boolean;
  onEdit: (w: Widget) => void;
  onDelete: (w: Widget) => void;
} | null = null;

vi.mock("@/features/dashboards/components/DashboardGrid", () => ({
  DashboardGrid: (props: {
    widgets: Widget[];
    layout: unknown;
    range: unknown;
    readOnly?: boolean;
    onEdit: (w: Widget) => void;
    onDelete: (w: Widget) => void;
  }) => {
    lastGridProps = props;
    return (
      <div data-testid="dashboard-grid">
        {props.widgets.map((w) => (
          <div key={w.id}>
            <button onClick={() => props.onEdit(w)}>{`edit-${w.id}`}</button>
            <button onClick={() => props.onDelete(w)}>{`delete-${w.id}`}</button>
          </div>
        ))}
      </div>
    );
  },
}));

import { useDashboard } from "@/features/dashboards/hooks/use-dashboards";

// d1 is a user dashboard; d2 is the seeded default (Overview) — both are
// fully editable, the default is just auto-created and home-marked.
const DASH_A: DashboardSummary = {
  id: "d1",
  name: "Custom",
  description: null,
  isDefault: false,
  createTime: "",
  updateTime: "",
};
const DASH_B: DashboardSummary = {
  id: "d2",
  name: "Overview",
  description: null,
  isDefault: true,
  createTime: "",
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
    updateLayout.mutate.mockReset();
    removeWidget.mutate.mockReset();
    lastGridProps = null;
    mockDetail({ ...DASH_A, layout: [], widgets: [] });
  });

  it("shows the dashboard's name in the header with a back link to the list", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Custom" })).toBeTruthy();
    // the breadcrumb reads exactly like the list page's heading (no arrow)
    const back = screen.getByRole("link", { name: "Dashboards" });
    expect(back.getAttribute("href")).toBe("/projects/p1/dashboard?list=1");
    // No tab strip: the other dashboard is not rendered here anymore.
    expect(screen.queryByText("Overview")).toBeNull();
  });

  it("shows the default dashboard's plain name in the header, no marker glyph", () => {
    mockDetail({ ...DASH_B, layout: [], widgets: [] });
    renderPage();

    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.queryByText("⌂")).toBeNull();
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

  it("shows the create-widget button and passes no readOnly prop for the default dashboard", () => {
    mockDetail({ ...DASH_B, layout: [], widgets: [WIDGET] });
    renderPage();

    expect(screen.getAllByRole("button", { name: "＋ Create widget" }).length).toBe(1);
    expect(lastGridProps?.readOnly).toBeUndefined();
  });

  it("holds the create-widget button until the dashboard detail loads", () => {
    mockDetail(undefined);
    renderPage();

    expect(screen.queryByRole("button", { name: "＋ Create widget" })).toBeNull();
  });

  it("offers no delete affordance — deleting lives in the list page's row actions", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: "Delete dashboard" })).toBeNull();
    expect(screen.queryByText("Delete Dashboard")).toBeNull();
  });

  it("renders the create-widget button before the time-range control", () => {
    renderPage();
    const create = screen.getAllByRole("button", { name: "＋ Create widget" })[0];
    const range = screen.getByRole("button", { name: "Last 24 hours" });
    expect(create.compareDocumentPosition(range) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  });

  it("passes widgets, layout and range to the grid and wires edit/delete", () => {
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

    fireEvent.click(screen.getByRole("button", { name: "delete-w1" }));
    expect(removeWidget.mutate).toHaveBeenCalledWith("w1");

    fireEvent.click(screen.getByRole("button", { name: "edit-w1" }));
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d1/widgets/w1/edit");
  });
});
