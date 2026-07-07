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
  isPending: boolean;
  error: Error | null;
} = { mutate: vi.fn(), isPending: false, error: null };
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

vi.mock("@/features/dashboards/hooks/use-dashboards", () => ({
  useDashboards: vi.fn(),
  useDashboard: vi.fn(),
  useDashboardMutations: () => ({ createDashboard, updateLayout, createWidget, removeWidget }),
}));

let lastGridProps: {
  widgets: Widget[];
  layout: unknown;
  range: unknown;
  onEdit: (w: Widget) => void;
  onDuplicate: (w: Widget) => void;
  onDelete: (w: Widget) => void;
} | null = null;

vi.mock("@/features/dashboards/components/DashboardGrid", () => ({
  DashboardGrid: (props: {
    widgets: Widget[];
    layout: unknown;
    range: unknown;
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

const DASH_A: DashboardSummary = {
  id: "d1",
  name: "Overview",
  description: null,
  isDefault: true,
  updateTime: "",
};
const DASH_B: DashboardSummary = {
  id: "d2",
  name: "Costs",
  description: null,
  isDefault: false,
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
    lastGridProps = null;
    mockLists([DASH_A, DASH_B]);
    mockDetail({ ...DASH_A, layout: [], widgets: [] });
  });

  it("renders dashboard tabs with the default marked and the current one highlighted", () => {
    renderPage();

    const overviewTab = screen.getByRole("link", { name: /Overview/ });
    expect(overviewTab.textContent).toContain("⌂");
    expect(overviewTab.getAttribute("aria-current")).toBe("page");

    const costsTab = screen.getByRole("link", { name: "Costs" });
    expect(costsTab.textContent).not.toContain("⌂");
    expect(costsTab.getAttribute("aria-current")).toBeNull();

    expect(screen.getByRole("button", { name: "＋ new" })).toBeTruthy();
  });

  it("does not create a dashboard when the new-dashboard prompt is cancelled", () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "＋ new" }));

    expect(createDashboard.mutate).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("creates a dashboard from the prompt and navigates to it on success", () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("New dash");
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "＋ new" }));

    expect(createDashboard.mutate).toHaveBeenCalledTimes(1);
    const [payload, options] = createDashboard.mutate.mock.calls[0];
    expect(payload).toEqual({ name: "New dash" });

    options.onSuccess({ dashboard: { id: "d9" } });
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d9");
    promptSpy.mockRestore();
  });

  it("shows the active range preset label", () => {
    renderPage();
    expect(screen.getByRole("button", { name: "Last 7 days" })).toBeTruthy();
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

  it("redirects to the dashboard index and invalidates the list cache when the dashboard fails to load", () => {
    mockDetail(undefined, new Error("404"));
    const { invalidateSpy } = renderPage();

    expect(replace).toHaveBeenCalledWith("/projects/p1/dashboard");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["dashboards", "p1"] });
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
    });

    fireEvent.click(screen.getByRole("button", { name: "delete-w1" }));
    expect(removeWidget.mutate).toHaveBeenCalledWith("w1");

    fireEvent.click(screen.getByRole("button", { name: "edit-w1" }));
    expect(push).toHaveBeenCalledWith("/projects/p1/dashboard/d1/widgets/w1/edit");
  });
});
