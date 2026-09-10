// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { formatDate } from "@/lib/utils";
import { AlertsTable } from "./alerts-table";
import type { AlertSummary } from "../hooks/use-alerts";

// Rows carry relative-time state, so the tests that read it run at a fixed
// instant rather than on the day the suite happens to run.
const NOW = new Date("2026-08-01T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const makeAlert = (overrides: Partial<AlertSummary> = {}): AlertSummary => ({
  id: "alert-1",
  name: "P95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "10m",
  thresholdOperator: ">",
  threshold: 500,
  status: "ACTIVE",
  severity: "OK",
  severityChangedAt: null,
  alertedAt: null,
  lastEvaluatedAt: ago(MINUTE),
  lastError: null,
  lastErrorAt: null,
  lastNotifyStatus: null,
  lastNotifyError: null,
  lastNotifyAt: null,
  createTime: ago(30 * 24 * HOUR),
  updateTime: ago(30 * 24 * HOUR),
  creator: "Ada",
  ...overrides,
});

const renderTable = (alert: AlertSummary, overrides: Record<string, unknown> = {}) => {
  const onToggleStatus = vi.fn();
  const onDelete = vi.fn();
  render(
    <AlertsTable
      alerts={[alert]}
      projectId="proj-1"
      onToggleStatus={onToggleStatus}
      onDelete={onDelete}
      isStatusPending={false}
      {...overrides}
    />,
  );
  return { onToggleStatus, onDelete };
};

const openActionsMenu = (alertName = "P95 latency") =>
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${alertName}` }));

describe("AlertsTable", () => {
  afterEach(cleanup);

  it("puts the three actions behind a row menu, each with an accessible name", () => {
    renderTable(makeAlert());

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    openActionsMenu();

    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("flips to a resume action for a paused alert", () => {
    const alert = makeAlert({ status: "PAUSED" });
    const { onToggleStatus } = renderTable(alert);

    openActionsMenu();

    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(onToggleStatus).toHaveBeenCalledWith(alert);
  });

  it("disables the status action while a status change is in flight", () => {
    const { onToggleStatus } = renderTable(makeAlert(), { isStatusPending: true });

    openActionsMenu();
    const pause = screen.getByRole("button", { name: "Pause" });
    expect((pause as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(pause);
    expect(onToggleStatus).not.toHaveBeenCalled();
  });

  it("points Edit at the alert itself, not at a blank create form", () => {
    renderTable(makeAlert({ id: "alert-7" }));

    openActionsMenu();

    // The href is the whole fix: aimed at /alerts/new, saving the edit wrote a second rule.
    expect(screen.getByRole("link", { name: "Edit" }).getAttribute("href")).toBe(
      "/projects/proj-1/alerts/alert-7",
    );
  });

  it("hands delete to the caller instead of deleting anything itself", () => {
    const alert = makeAlert();
    const { onDelete } = renderTable(alert);

    openActionsMenu();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledWith(alert);
  });

  it("badges a rule whose last run failed as failing, not as the severity it stopped at", () => {
    renderTable(makeAlert({ severity: "OK", lastError: "ClickHouse read timeout" }));

    const row = screen.getByText("P95 latency").closest("tr");
    expect(row?.textContent).toContain("Failing");
    expect(row?.textContent).not.toContain("OK");

    // The reason sits behind the badge, where a keyboard can reach it.
    fireEvent.click(screen.getByRole("button", { name: "Failing" }));
    expect(screen.getByText(/ClickHouse read timeout/)).toBeTruthy();
  });

  it("puts a failed page's reason, and its way out, behind the badge", () => {
    const undelivered = { lastNotifyStatus: "FAILED", lastNotifyError: "no-channel" };
    renderTable(makeAlert(undelivered), { workspaceId: "ws-1" });

    // The badge still reports the run that succeeded; delivery is the reason
    // beneath it, not a state of its own.
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText(/No Slack channel is set for this workspace/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Slack settings" }).getAttribute("href")).toBe(
      "/workspaces/ws-1/settings/integrations",
    );

    cleanup();
    // With no workspace resolved the reason still shows and the link does not.
    renderTable(makeAlert(undelivered));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));

    expect(screen.getByText(/No Slack channel is set for this workspace/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Slack settings" })).toBeNull();
  });

  // The badge and the row menu are left on the real clock: opening either needs animation frames.
  describe("evaluation state in the row", () => {
    beforeEach(() => {
      vi.useFakeTimers({ now: NOW });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows when a rule last ran as an absolute timestamp, with the relative time on hover", () => {
      const lastEvaluatedAt = ago(5 * MINUTE);
      renderTable(makeAlert({ lastEvaluatedAt }));

      const cell = screen.getByText(formatDate(lastEvaluatedAt));
      expect(cell.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      expect(cell.getAttribute("title")).toBe("5 minutes ago");
    });

    it("still says Never for a rule that has not been evaluated", () => {
      renderTable(makeAlert({ lastEvaluatedAt: null }));

      const cell = screen.getByText("Never");
      expect(cell.getAttribute("title")).toBeNull();
    });
  });
});
