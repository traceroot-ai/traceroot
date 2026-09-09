// @vitest-environment jsdom
/**
 * Component smoke for the two evaluation drawers that no view mounts today:
 * "Copy starter code" (RunEvaluationDrawer) and the server-wired
 * TestCaseReviewDrawer. Both are rendered directly against a stubbed fetch, the
 * same way the view smokes do it.
 */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@/components/ui/toast";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/projects/p1/evaluations",
}));

import { RunEvaluationDrawer } from "./components/run-evaluation-drawer";
import { TestCaseReviewDrawer } from "@/features/offline-eval/components";

const DATASETS = [
  {
    id: "ds_billing",
    projectId: "p1",
    name: "Billing routing",
    description: null,
    currentVersionId: "dsv_12",
    createTime: "2026-07-16T00:00:00Z",
    updateTime: "2026-07-17T00:00:00Z",
    caseCount: 8,
    versionCount: 3,
  },
  {
    id: "ds_refunds",
    projectId: "p1",
    name: "Refund routing",
    description: null,
    currentVersionId: "dsv_3",
    createTime: "2026-07-16T00:00:00Z",
    updateTime: "2026-07-17T00:00:00Z",
    caseCount: 4,
    versionCount: 1,
  },
];

let datasets = DATASETS;

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

beforeEach(() => {
  datasets = DATASETS;
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: datasets, meta: { page: 0, limit: 200, total: datasets.length } }),
  })) as unknown as typeof fetch;
});
afterEach(() => cleanup());

function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{node}</ToastProvider>
    </QueryClientProvider>,
  );
}

/** The drawer body, so snippet assertions read its text as one string. */
function panel() {
  return screen.getByText("Copy starter code").closest("div.fixed") as HTMLElement;
}

/**
 * Mounts the drawer closed, lets the dataset list resolve, then opens it — the
 * real sequence. The default dataset is chosen by the open transition, so a
 * drawer that is already open on its very first render has nothing to pick yet.
 */
async function openDrawer(props: { datasetId?: string } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const ui = (open: boolean) => (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <RunEvaluationDrawer
          projectId="p1"
          open={open}
          onOpenChange={onOpenChange}
          datasetId={props.datasetId}
        />
      </ToastProvider>
    </QueryClientProvider>
  );
  const view = render(ui(false));
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  view.rerender(ui(true));
  await screen.findByText("Copy starter code");
  return { onOpenChange };
}

describe("RunEvaluationDrawer", () => {
  it("renders nothing while closed", () => {
    mount(<RunEvaluationDrawer projectId="p1" open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Copy starter code")).toBeNull();
  });

  it("defaults to the first dataset and fills its real ids into the Python snippet", async () => {
    await openDrawer();
    await waitFor(() => expect(panel().textContent).toContain('pull_dataset("ds_billing")'));
    // Both the dataset id and the version id the run will measure are pre-filled.
    expect(panel().textContent).toContain("dsv_12");
    expect(panel().textContent).toContain('name="Billing routing"');
    // Nothing runs from the panel — it is a snippet, not a form.
    expect(screen.getByText("Nothing runs from this panel.")).toBeDefined();
  });

  it("switches the snippet to TypeScript and back", async () => {
    await openDrawer();
    await waitFor(() => expect(panel().textContent).toContain("pull_dataset"));

    fireEvent.click(screen.getByRole("button", { name: "TypeScript" }));
    await waitFor(() => expect(panel().textContent).toContain("await evaluate"));
    expect(panel().textContent).toContain('await pullDataset("ds_billing")');
    expect(panel().textContent).not.toContain("pull_dataset");

    fireEvent.click(screen.getByRole("button", { name: "Python" }));
    await waitFor(() => expect(panel().textContent).toContain("pull_dataset"));
  });

  it("picking a different dataset rewrites the snippet's ids", async () => {
    await openDrawer();
    await waitFor(() => expect(panel().textContent).toContain("ds_billing"));

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Refund routing" }));

    await waitFor(() => expect(panel().textContent).toContain('pull_dataset("ds_refunds")'));
    expect(panel().textContent).toContain("dsv_3");
  });

  it("a datasetId prefills the dataset and hides the picker", async () => {
    await openDrawer({ datasetId: "ds_refunds" });
    // No selector at all when opened from a dataset.
    expect(screen.queryByRole("combobox")).toBeNull();
    await waitFor(() => expect(screen.getByText("Refund routing")).toBeDefined());
    expect(panel().textContent).toContain('pull_dataset("ds_refunds")');
  });

  it("falls back to placeholder ids when the project has no datasets", async () => {
    datasets = [];
    await openDrawer();
    await waitFor(() => expect(panel().textContent).toContain('pull_dataset("ds_...")'));
    expect(screen.getByText("No datasets found")).toBeDefined();
  });

  it("opens to a non-selectable 'No datasets found' row when the project has no datasets", async () => {
    datasets = [];
    await openDrawer();

    fireEvent.click(screen.getByRole("combobox"));
    // The popover shows the empty-state copy and offers nothing to pick.
    await waitFor(() => expect(screen.getAllByText("No datasets found").length).toBeGreaterThan(1));
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("closes from the X, from Done, and from Escape", async () => {
    const { onOpenChange } = await openDrawer();

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    onOpenChange.mockClear();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // A key the drawer doesn't own is ignored.
    onOpenChange.mockClear();
    fireEvent.keyDown(window, { key: "a" });
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

const TARGET = {
  contextLabel: "tc_9f2 · Billing routing",
  input: "I was charged twice for my July invoice",
  expected: "billing",
  currentReview: "needs_review" as const,
};

describe("TestCaseReviewDrawer (server-wired)", () => {
  it("renders nothing without a target", () => {
    mount(<TestCaseReviewDrawer target={null} open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByText("Review test case")).toBeNull();
  });

  it("shows the case being reviewed and every verification check", async () => {
    mount(<TestCaseReviewDrawer target={TARGET} open onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(await screen.findByText("Review test case")).toBeDefined();
    expect(screen.getByText("tc_9f2 · Billing routing")).toBeDefined();
    // Input/Expected render in the shared ValueBlock (a read-only field), so their
    // content is the field value, not free text.
    expect(screen.getByDisplayValue(/charged twice/)).toBeDefined();
    expect(screen.getByDisplayValue("billing")).toBeDefined();
    expect(screen.getAllByRole("checkbox").length).toBe(5);
    // Ready is advisory, and the copy says so.
    expect(screen.getByText(/never blocks the case from an evaluation/)).toBeDefined();
  });

  it("Mark ready submits without a correction and leaves closing to the caller", async () => {
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    mount(
      <TestCaseReviewDrawer target={TARGET} open onOpenChange={onOpenChange} onSubmit={onSubmit} />,
    );
    const boxes = await screen.findAllByRole("checkbox");
    // "Mark ready" is gated on every verification check: a half-reviewed case must
    // not be publishable as ready.
    fireEvent.click(boxes[0]);
    expect(screen.getByRole("button", { name: "Mark ready" }).hasAttribute("disabled")).toBe(true);
    boxes.slice(1).forEach((b) => fireEvent.click(b));

    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    expect(onSubmit).toHaveBeenCalledWith({ review: "ready", correctedExpected: undefined });
    // The drawer does not close itself: the save may still be in flight or fail, so
    // the caller closes it only once it has actually persisted.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("a changed expected outcome rides along, trimmed", async () => {
    const onSubmit = vi.fn();
    mount(<TestCaseReviewDrawer target={TARGET} open onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(await screen.findByLabelText(/Correct the expected outcome/), {
      target: { value: "  refunds  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Needs work" }));
    expect(onSubmit).toHaveBeenCalledWith({
      review: "needs_review",
      correctedExpected: "refunds",
    });
  });

  it("retyping the same expected outcome is not treated as a correction", async () => {
    const onSubmit = vi.fn();
    mount(<TestCaseReviewDrawer target={TARGET} open onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(await screen.findByLabelText(/Correct the expected outcome/), {
      target: { value: "billing" },
    });
    screen.getAllByRole("checkbox").forEach((b) => fireEvent.click(b));
    fireEvent.click(screen.getByRole("button", { name: "Mark ready" }));
    expect(onSubmit).toHaveBeenCalledWith({ review: "ready", correctedExpected: undefined });
  });

  it("an empty input and a missing expected read as placeholders", async () => {
    mount(
      <TestCaseReviewDrawer
        target={{ ...TARGET, input: "", expected: null }}
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(await screen.findByText("—")).toBeDefined();
    expect(screen.getByText(/Not required — a scorer judges the output directly/)).toBeDefined();
    // With no expected, the correction field prompts with an example instead.
    expect(screen.getByPlaceholderText("e.g. billing")).toBeDefined();
  });

  it("reopening on a new target resets the checks and the correction", async () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <TestCaseReviewDrawer target={TARGET} open onOpenChange={vi.fn()} onSubmit={onSubmit} />,
    );
    fireEvent.change(await screen.findByLabelText(/Correct the expected outcome/), {
      target: { value: "refunds" },
    });
    fireEvent.click((await screen.findAllByRole("checkbox"))[0]);

    rerender(
      <TestCaseReviewDrawer
        target={{ ...TARGET, contextLabel: "tc_aaa · Billing routing" }}
        open
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await waitFor(() =>
      expect(
        (screen.getByLabelText(/Correct the expected outcome/) as HTMLInputElement).value,
      ).toBe(""),
    );
    expect(screen.getAllByRole("checkbox").every((b) => !(b as HTMLInputElement).checked)).toBe(
      true,
    );
  });
});
