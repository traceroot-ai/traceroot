// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AlertListCard } from "./alert-list-card";
import type { AlertListCardModel, AlertListRow } from "../lib/resource-card";

afterEach(cleanup);

function row(overrides: Partial<AlertListRow> = {}): AlertListRow {
  return {
    id: "al-1",
    name: "p95 latency over 2s",
    summary: "p95 latency > 2,000 ms over 10m",
    state: "evaluated 2 minutes ago",
    badge: {
      status: "ACTIVE",
      severity: "OK",
      lastError: null,
      lastEvaluatedAt: "2026-09-11T14:48:00Z",
      lastNotifyStatus: null,
      lastNotifyError: null,
    },
    href: "/projects/p1/alerts/al-1",
    ...overrides,
  };
}

function model(overrides: Partial<AlertListCardModel> = {}): AlertListCardModel {
  return {
    rows: [row()],
    total: 1,
    capacity: { used: 1, max: 100 },
    href: "/projects/p1/alerts",
    ...overrides,
  };
}

describe("AlertListCard", () => {
  it("lists one linked row per alert with its rule, state and the alerts page's badge", () => {
    render(
      <AlertListCard
        model={model({
          rows: [
            row(),
            row({
              id: "al-2",
              name: "Error rate spike",
              summary: "count ≥ 25 over 5m",
              state: "alerted 13 minutes ago · notified",
              badge: {
                status: "ACTIVE",
                severity: "ALERT",
                lastError: null,
                lastEvaluatedAt: "2026-09-11T14:48:00Z",
                lastNotifyStatus: "DELIVERED",
                lastNotifyError: null,
              },
              href: "/projects/p1/alerts/al-2",
            }),
            row({
              id: "al-3",
              name: "Daily spend",
              summary: "sum cost > $40 over 1h",
              state: "paused",
              badge: {
                status: "PAUSED",
                severity: "OK",
                lastError: null,
                lastEvaluatedAt: null,
                lastNotifyStatus: null,
                lastNotifyError: null,
              },
              href: "/projects/p1/alerts/al-3",
            }),
          ],
          total: 3,
          capacity: { used: 3, max: 100 },
        })}
      />,
    );
    expect(screen.getByText("p95 latency over 2s")).toBeTruthy();
    expect(
      screen.getByText("p95 latency > 2,000 ms over 10m · evaluated 2 minutes ago"),
    ).toBeTruthy();
    expect(screen.getByText("count ≥ 25 over 5m · alerted 13 minutes ago · notified")).toBeTruthy();
    expect(screen.getByText("sum cost > $40 over 1h · paused")).toBeTruthy();
    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.getByText("Alert")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();

    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/p1/alerts/al-1",
      "/projects/p1/alerts/al-2",
      "/projects/p1/alerts/al-3",
      "/projects/p1/alerts",
    ]);
    expect(screen.getByText("3 alerts")).toBeTruthy();
    expect(screen.getByText("3 of 100 used")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open alerts" })).toBeTruthy();
  });

  it("keeps the severity badge outside the row's link, so opening its popover does not navigate", () => {
    render(<AlertListCard model={model()} />);
    const badge = screen.getByText("OK");
    expect(badge.closest("a")).toBeNull();
    const link = screen.getByRole("link", { name: /p95 latency over 2s/ });
    expect(link.getAttribute("href")).toBe("/projects/p1/alerts/al-1");
    expect(link.textContent).not.toContain("OK");
  });

  it("says a row's state alone when it carries no whole rule, and skips a badge it cannot resolve", () => {
    render(
      <AlertListCard
        model={model({ rows: [row({ summary: null, state: "not evaluated yet", badge: null })] })}
      />,
    );
    expect(screen.getByText("not evaluated yet")).toBeTruthy();
    expect(screen.queryByText("OK")).toBeNull();
    expect(screen.queryByText("No Data")).toBeNull();
  });

  it("says how many the read covered when the project holds more than the rows shown", () => {
    render(<AlertListCard model={model({ total: 42, capacity: null })} />);
    expect(screen.getByText("42 alerts · showing 1")).toBeTruthy();
    expect(screen.queryByText(/of 100 used/)).toBeNull();
  });

  it("singularizes one alert and offers no links when the panel has no project", () => {
    render(<AlertListCard model={model({ rows: [row({ href: null })], href: null })} />);
    expect(screen.getByText("1 alert")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("p95 latency over 2s")).toBeTruthy();
  });

  it("says so when the project has no alerts", () => {
    render(
      <AlertListCard model={model({ rows: [], total: 0, capacity: { used: 0, max: 100 } })} />,
    );
    expect(screen.getByText("No alerts in this project.")).toBeTruthy();
    expect(screen.getByText("0 alerts")).toBeTruthy();
    expect(screen.getByText("0 of 100 used")).toBeTruthy();
  });
});
