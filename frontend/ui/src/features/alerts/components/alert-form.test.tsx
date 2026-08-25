// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cloneElement, isValidElement, type ReactNode } from "react";
import type { AlertCapacity } from "../capacity";

// Radix Select opens on pointerdown and relies on pointer-capture APIs jsdom
// doesn't implement.
window.HTMLElement.prototype.hasPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
window.HTMLElement.prototype.scrollIntoView = vi.fn();

// jsdom reports 0x0 for the container recharts measures against, so
// ResponsiveContainer renders nothing. Stub it with a fixed-size div that clones the child.
vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("recharts")>();
  return {
    ...actual,
    ResponsiveContainer: ({
      children,
    }: {
      children:
        | React.ReactElement
        | ((size: { width: number; height: number }) => React.ReactElement);
    }) => {
      const size = { width: 800, height: 400 };
      const chart = typeof children === "function" ? children(size) : children;
      return (
        <div style={{ width: size.width, height: size.height }}>
          {isValidElement(chart) ? cloneElement(chart, size) : chart}
        </div>
      );
    },
  };
});

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useProject: vi.fn(),
  useSlackStatus: vi.fn(),
  useWidgetPreview: vi.fn(),
  useWidgetSchema: vi.fn(),
  useWidgetFieldValues: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/features/projects/hooks", () => ({ useProject: mocks.useProject }));
vi.mock("@/features/integrations/hooks/useSlackIntegration", () => ({
  useSlackStatus: mocks.useSlackStatus,
}));
vi.mock("@/features/dashboards/hooks/use-widget-data", () => ({
  useWidgetPreview: mocks.useWidgetPreview,
  useWidgetSchema: mocks.useWidgetSchema,
  useWidgetFieldValues: mocks.useWidgetFieldValues,
}));
// With no session the metadata key suggestion query stays disabled; the only fetch is the POST.
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
}));

const stringField = (label: string, extra: Record<string, unknown> = {}) => ({
  type: "string",
  label,
  filterOps: ["=", "contains"],
  groupable: true,
  ...extra,
});

// The spans fields the engine reports, trimmed to the ones the form asks for.
const SPANS_SCHEMA_FIELDS = {
  model_name: stringField("Model"),
  environment: stringField("Environment"),
  status: stringField("Status"),
  span_kind: stringField("Span kind"),
  name: stringField("Span name"),
  is_root: stringField("Root span"),
  metadata: stringField("Metadata", { requiresKey: true }),
};

// The engine's numeric set. `count` is absent: the engine reserves it for the count(*) sentinel.
const NUMBER_AGGS = ["sum", "avg", "max", "min", "p50", "p75", "p90", "p95", "p99", "uniq"];

// The preview buckets on the rule's evaluation window, so an untouched draft charts 10m.
const DEFAULT_BUCKET_SECONDS = 600;

const DEFAULT_POSTED_RULE = {
  name: "p95 latency",
  view: "SPANS",
  measure: "count",
  aggregation: "count",
  filters: [],
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  renotify: { mode: "OFF" },
};

import { AlertForm, type AlertDraft } from "./alert-form";

const SAVED_DRAFT: AlertDraft = {
  view: "SPANS",
  measureId: "latency",
  aggregation: "p95",
  filters: [],
  operator: ">",
  threshold: "250",
  window: "1h",
  renotify: { mode: "OFF" },
  name: "Checkout latency",
};

describe("AlertForm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  // Retries off so a failed save surfaces its message at once.
  const newQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  const renderForm = (
    props: {
      alertId?: string;
      initialDraft?: AlertDraft;
      schemaPending?: boolean;
      schemaError?: boolean;
    } = {},
    // One client per render keeps the cases independent.
    queryClient = newQueryClient(),
  ) => {
    mocks.useProject.mockReturnValue({ data: { workspace_id: "ws-1" } });
    mocks.useSlackStatus.mockReturnValue({ data: { connected: false } });
    mocks.useWidgetPreview.mockReturnValue({ isPending: true, error: null, data: undefined });
    mocks.useWidgetSchema.mockReturnValue(
      props.schemaPending
        ? { data: undefined, isPending: true, isError: false }
        : props.schemaError
          ? { data: undefined, isPending: false, isError: true }
          : { data: { spans: { fields: SPANS_SCHEMA_FIELDS }, traces: { fields: {} } } },
    );
    mocks.useWidgetFieldValues.mockReturnValue({ values: [], isLoading: false });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { schemaPending: _schemaPending, schemaError: _schemaError, ...formProps } = props;
    return render(<AlertForm projectId="proj-1" {...formProps} />, { wrapper });
  };

  async function addFilter(fieldLabel: string, value: string) {
    fireEvent.click(screen.getByRole("button", { name: /Add filter/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Field/ }));
    fireEvent.click(await screen.findByRole("option", { name: fieldLabel }));
    fireEvent.change(screen.getByLabelText("value"), { target: { value } });
  }

  function openSelect(label: string) {
    fireEvent.pointerDown(screen.getByLabelText(label), { button: 0, pointerType: "mouse" });
  }

  function saveButton() {
    return screen.getByRole("button", { name: "Create Alert" });
  }

  function fillRequiredFields(name = "p95 latency", threshold = "500") {
    fireEvent.change(screen.getByLabelText("name"), { target: { value: name } });
    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: threshold } });
  }

  /** The form issues a capacity GET besides its save, so the stub answers by method. */
  function stubFetch(body: unknown, ok = true, status = 200, capacity?: AlertCapacity) {
    const save = { ok, status, json: async () => body };
    const capacityPage = {
      ok: true,
      status: 200,
      json: async () => ({ data: [], meta: { page: 0, limit: 1, total: 0, capacity } }),
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === undefined ? capacityPage : save,
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function stubCreateSuccess() {
    return stubFetch({ alert: { id: "alert-1" } });
  }

  /** The writes the form issued, selected by method rather than by index. */
  const writeCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method !== undefined,
    ) as [string, RequestInit][];

  function postedRule(fetchMock: ReturnType<typeof vi.fn>) {
    const [[, init]] = writeCalls(fetchMock);
    return JSON.parse(String(init.body));
  }

  const previewBucketSeconds = () => mocks.useWidgetPreview.mock.calls.at(-1)?.[3];

  it("saves the window the Conditions section shows, not the one the form opened on", async () => {
    const fetchMock = stubCreateSuccess();
    renderForm();
    openSelect("window");
    fireEvent.click(await screen.findByRole("option", { name: "Last 1h" }));
    fillRequiredFields();
    fireEvent.click(saveButton());

    // The default is 10m, so a window that never reached the draft would post by accident.
    expect(screen.getByLabelText("window").textContent).toContain("Last 1h");
    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(postedRule(fetchMock).window).toBe("1h");
  });

  it("offers a numeric measure the engine-runnable aggregations, count excluded", async () => {
    renderForm();
    openSelect("measure");
    fireEvent.click(await screen.findByRole("option", { name: "Latency" }));

    openSelect("aggregation");
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(NUMBER_AGGS);
  });

  it("blocks the save until the name and the threshold are both real", () => {
    renderForm();
    fillRequiredFields("   ");
    // `required` stops the empty string; it does not stop three spaces.
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("name"), { target: { value: "p95 latency" } });
    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: "" } });
    // Number("") is 0 and the schema accepts 0, so blank has to be its own refusal.
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByLabelText("threshold"), { target: { value: "0" } });
    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("posts the draft under the names the create endpoint reads", async () => {
    const fetchMock = stubCreateSuccess();
    renderForm();
    fillRequiredFields();
    fireEvent.click(saveButton());

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    const [url, init] = writeCalls(fetchMock)[0];
    expect(url).toBe("/api/projects/proj-1/alerts");
    expect(init.method).toBe("POST");
    // Whole-body equality: `measureId`/`operator` are `measure`/`thresholdOperator` on the wire.
    expect(postedRule(fetchMock)).toEqual(DEFAULT_POSTED_RULE);
    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/projects/proj-1/alerts"));
  });

  it("charts the preview on the window the Conditions section shows", async () => {
    renderForm();
    expect(previewBucketSeconds()).toBe(DEFAULT_BUCKET_SECONDS);

    openSelect("window");
    fireEvent.click(await screen.findByRole("option", { name: "Last 1h" }));

    // A chart bucketed on anything else describes a rule the user is not writing.
    expect(previewBucketSeconds()).toBe(3600);
  });

  it("keeps the user on the form and shows the server's reason when the save fails", async () => {
    stubFetch({ detail: "An alert with that name exists" }, false, 409);
    renderForm();
    fillRequiredFields();
    fireEvent.click(saveButton());

    const message = await screen.findByText("An alert with that name exists");
    expect(message.className).toContain("text-destructive");
    // The draft is still on screen to edit, not thrown away by a navigation.
    expect(mocks.push).not.toHaveBeenCalled();
    expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("p95 latency");
  });

  it("drops a filter row with no value from the saved rule", async () => {
    const fetchMock = stubCreateSuccess();
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /Add filter/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Field/ }));
    fireEvent.click(await screen.findByRole("option", { name: "Model" }));
    // The row is on screen and empty: the payload drops it.
    expect((screen.getByLabelText("value") as HTMLInputElement).value).toBe("");
    fillRequiredFields();
    fireEvent.click(saveButton());

    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(postedRule(fetchMock).filters).toEqual([]);
  });

  it("drops a keyless metadata row rather than saving a filter the engine cannot run", async () => {
    const fetchMock = stubCreateSuccess();
    renderForm();
    await addFilter("Metadata", "gold");
    expect((screen.getByLabelText("metadata key") as HTMLInputElement).value).toBe("");
    fillRequiredFields();
    fireEvent.click(saveButton());

    // The schema takes a metadata predicate with no map key, so this one would store cleanly.
    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    expect(postedRule(fetchMock).filters).toEqual([]);
  });

  it("saves a keyed metadata row on the same key the preview charts", async () => {
    const fetchMock = stubCreateSuccess();
    renderForm();
    await addFilter("Metadata", "gold");
    fireEvent.change(screen.getByLabelText("metadata key"), { target: { value: "  user_tier  " } });
    fillRequiredFields();

    const applied = { field: "metadata", key: "user_tier", op: "=", value: "gold" };
    expect(mocks.useWidgetPreview).toHaveBeenLastCalledWith(
      "proj-1",
      expect.objectContaining({ filters: [applied] }),
      expect.anything(),
      DEFAULT_BUCKET_SECONDS,
    );

    fireEvent.click(saveButton());
    await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    // Trimmed identically on both paths, or the chart and the rule would read different keys.
    expect(postedRule(fetchMock).filters).toEqual([applied]);
  });

  it("refuses a filtered unique-id measure: no preview, and no Create", async () => {
    renderForm();
    openSelect("measure");
    fireEvent.click(await screen.findByRole("option", { name: "Unique user ids" }));
    // Unfiltered it previews fine off the traces view, so the refusal below is the filter's.
    expect(mocks.useWidgetPreview).toHaveBeenLastCalledWith(
      "proj-1",
      expect.objectContaining({ view: "traces", metric: { measure: "user_id", agg: "uniq" } }),
      expect.anything(),
      DEFAULT_BUCKET_SECONDS,
    );

    await addFilter("Span kind", "LLM");
    fillRequiredFields();

    // The distinct count stops being grain-invariant once spans are filtered.
    expect(mocks.useWidgetPreview).toHaveBeenLastCalledWith(
      "proj-1",
      null,
      expect.anything(),
      DEFAULT_BUCKET_SECONDS,
    );
    expect(screen.getByText("No preview available for this metric yet.")).toBeTruthy();
    expect(saveButton().hasAttribute("disabled")).toBe(true);
  });

  describe("editing a stored rule", () => {
    const previewMetrics = () =>
      mocks.useWidgetPreview.mock.calls.map(
        ([, spec]) => (spec as { metric?: unknown } | null)?.metric,
      );

    it("previews the loaded rule from the first render, never the create defaults", () => {
      renderForm({ alertId: "alert-9", initialDraft: SAVED_DRAFT });

      expect((screen.getByLabelText("name") as HTMLInputElement).value).toBe("Checkout latency");
      // The first call, not the last: a frame on the defaults would bill a query.
      expect(previewMetrics()[0]).toEqual({ measure: "duration_ms", agg: "p95" });
      expect(previewMetrics()).not.toContainEqual({ measure: "count", agg: "count" });
    });

    it("saves by PATCHing the whole rule to the alert's own url", async () => {
      const fetchMock = stubFetch({ alert: { id: "alert-9" } });
      renderForm({ alertId: "alert-9", initialDraft: SAVED_DRAFT });

      expect(screen.queryByRole("button", { name: "Create Alert" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Save Alert" }));

      await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
      const [url, init] = writeCalls(fetchMock)[0];
      // A POST here is the duplicate the blank edit form used to create.
      expect(init.method).toBe("PATCH");
      expect(url).toBe("/api/projects/proj-1/alerts/alert-9");
      // The whole body, not a diff: the route's change detection compares values.
      expect(postedRule(fetchMock)).toEqual({
        name: "Checkout latency",
        view: "SPANS",
        measure: "latency",
        aggregation: "p95",
        filters: [],
        window: "1h",
        thresholdOperator: ">",
        threshold: 250,
        renotify: { mode: "OFF" },
      });
    });

    it("still saves at the cap, which only the create path spends a slot against", async () => {
      const fetchMock = stubFetch({ alert: { id: "alert-9" } }, true, 200, { used: 100, max: 100 });
      const queryClient = newQueryClient();
      renderForm({}, queryClient);
      fillRequiredFields();

      // Creating is held, which is also what proves the cap reached this form.
      expect(await screen.findByText(/This project has 100 of 100 alerts/)).toBeTruthy();
      expect(saveButton().hasAttribute("disabled")).toBe(true);

      cleanup();
      // Same client, so the settled capacity is there on the first edit render.
      renderForm({ alertId: "alert-9", initialDraft: SAVED_DRAFT }, queryClient);
      const save = screen.getByRole("button", { name: "Save Alert" });

      expect(save.hasAttribute("disabled")).toBe(false);
      expect(screen.queryByText(/This project has/)).toBeNull();

      fireEvent.click(save);
      await waitFor(() => expect(writeCalls(fetchMock)).toHaveLength(1));
    });
  });

  it("shows a saved filter as text with a spinner until the field schema resolves", () => {
    renderForm({
      alertId: "alert-9",
      schemaPending: true,
      initialDraft: {
        view: "SPANS",
        measureId: "count",
        aggregation: "count",
        filters: [{ field: "span_kind", op: "=", value: "AGENT" }],
        operator: ">",
        threshold: "1",
        window: "1m",
        renotify: { mode: "OFF" },
        name: "filtered",
      },
    });
    const row = screen.getByRole("status", { name: "Loading filter fields" });
    expect(row.textContent).toContain("span_kind = AGENT");
    // not an empty field dropdown that reads as "no filter"
    expect(screen.queryByRole("button", { name: /^Field/ })).toBeNull();
  });

  it("keeps a saved filter legible and removable when the field schema request fails", () => {
    renderForm({
      alertId: "alert-9",
      schemaError: true,
      initialDraft: {
        view: "SPANS",
        measureId: "count",
        aggregation: "count",
        filters: [{ field: "span_kind", op: "=", value: "AGENT" }],
        operator: ">",
        threshold: "1",
        window: "1m",
        renotify: { mode: "OFF" },
        name: "filtered",
      },
    });
    const row = screen.getByRole("alert", { name: "Filter fields unavailable" });
    expect(row.textContent).toContain("span_kind = AGENT");
    expect(screen.getByRole("button", { name: "Remove filter" })).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
