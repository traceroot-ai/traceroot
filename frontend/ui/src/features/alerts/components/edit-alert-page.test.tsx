// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api/client";
import type { AlertRecord } from "../hooks/use-alerts";

const mocks = vi.hoisted(() => ({ useAlert: vi.fn() }));

// Partial: `isAlertGone` is the classification under test, so only the load is controlled.
vi.mock("../hooks/use-alerts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks/use-alerts")>()),
  useAlert: (...args: unknown[]) => mocks.useAlert(...args),
}));

vi.mock("@/features/projects/components", () => ({ ProjectBreadcrumb: () => null }));
vi.mock("./alert-form", () => ({
  AlertForm: (props: Record<string, unknown>) => (
    <pre data-testid="form">{JSON.stringify(props)}</pre>
  ),
}));

import { EditAlertPage } from "./edit-alert-page";

const storedAlert: AlertRecord = {
  id: "alert-9",
  name: "Checkout latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "1h",
  thresholdOperator: ">",
  threshold: 250,
  filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
  renotify: { mode: "OFF" },
  status: "ACTIVE",
  severity: "OK",
  severityChangedAt: null,
  alertedAt: null,
  lastEvaluatedAt: null,
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  createTime: "2026-07-01T00:00:00.000Z",
  updateTime: "2026-07-01T00:00:00.000Z",
  creator: "Ada",
};

const loaded = (alert: AlertRecord) => ({ data: alert, isPending: false, error: null });
const failed = (error: Error) => ({ data: undefined, isPending: false, error });

const renderPage = () => render(<EditAlertPage projectId="proj-1" alertId="alert-9" />);

describe("EditAlertPage", () => {
  afterEach(() => {
    cleanup();
    mocks.useAlert.mockReset();
  });

  it("opens the form on the stored rule rather than on an empty draft", () => {
    mocks.useAlert.mockReturnValue(loaded(storedAlert));

    renderPage();

    // The threshold crosses as the input string, and the id turns the submit into an update.
    expect(JSON.parse(screen.getByTestId("form").textContent ?? "")).toEqual({
      projectId: "proj-1",
      alertId: "alert-9",
      initialDraft: {
        view: "SPANS",
        measureId: "latency",
        aggregation: "p95",
        filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
        operator: ">",
        threshold: "250",
        window: "1h",
        renotify: { mode: "OFF" },
        name: "Checkout latency",
      },
    });
  });

  it("separates a rule that is gone from a server fault, and opens no form for either", () => {
    for (const status of [404, 403]) {
      mocks.useAlert.mockReturnValue(failed(new ApiError(status, "Alert not found")));
      renderPage();

      // Deleted, or a workspace the user lost: nothing to edit either way.
      expect(screen.getByText("Alert not found")).toBeTruthy();
      expect(screen.queryByTestId("form")).toBeNull();
      cleanup();
    }

    mocks.useAlert.mockReturnValue(failed(new ApiError(500, "Database is unreachable")));
    renderPage();

    // An outage is a retry, not a deletion, so it must not read as one.
    expect(screen.getByText("Alert could not be edited")).toBeTruthy();
    expect(screen.getByText("Database is unreachable")).toBeTruthy();
  });
});
