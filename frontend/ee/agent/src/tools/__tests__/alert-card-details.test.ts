import { describe, expect, it } from "vitest";
import {
  ALERT_CARD_ROW_CAP,
  alertDetailCardDetails,
  alertListCardDetails,
} from "../alert-card-details.js";

const alert = (overrides: Record<string, unknown> = {}) => ({
  id: "al-1",
  name: "p95 latency",
  view: "SPANS",
  measure: "latency",
  aggregation: "p95",
  window: "10m",
  threshold_operator: ">",
  threshold: 2000,
  status: "ACTIVE",
  severity: "OK",
  severity_changed_at: "2026-09-11T14:35:00Z",
  alerted_at: null,
  last_evaluated_at: "2026-09-11T14:48:00Z",
  last_error: null,
  last_error_at: null,
  last_notify_status: null,
  last_notify_error: null,
  last_notify_at: null,
  create_time: "2026-09-04T10:00:00Z",
  update_time: "2026-09-11T14:48:00Z",
  creator: "Ada",
  ...overrides,
});

describe("alertListCardDetails", () => {
  it("projects each row to the fields a card needs and keeps the paging meta", () => {
    const details = alertListCardDetails({
      data: [alert(), alert({ id: "al-2", name: "Spend", threshold: "40" })],
      meta: { page: 0, limit: 50, total: 2, capacity: { used: 2, max: 100 } },
    });
    expect(details).toEqual({
      kind: "alert_list",
      total: 2,
      capacity: { used: 2, max: 100 },
      alerts: [
        {
          id: "al-1",
          name: "p95 latency",
          view: "SPANS",
          measure: "latency",
          aggregation: "p95",
          window: "10m",
          threshold_operator: ">",
          threshold: 2000,
          status: "ACTIVE",
          severity: "OK",
          alerted_at: null,
          last_evaluated_at: "2026-09-11T14:48:00Z",
          last_error: null,
          last_notify_status: null,
          last_notify_error: null,
          last_notify_at: null,
        },
        // A threshold that is not a number reads as unknown, never as text.
        expect.objectContaining({ id: "al-2", name: "Spend", threshold: null }),
      ],
    });
    // Nothing a row does not need travels: the timestamps the card never shows stay out.
    expect(details!.alerts[0]).not.toHaveProperty("update_time");
    expect(details!.alerts[0]).not.toHaveProperty("creator");
  });

  it("caps the rows a card carries, and drops rows with no id or name", () => {
    const many = Array.from({ length: ALERT_CARD_ROW_CAP + 5 }, (_, i) =>
      alert({ id: `al-${i}`, name: `Rule ${i}` }),
    );
    const details = alertListCardDetails({
      data: [...many, { name: "no id" }, { id: "no-name" }, "junk"],
      meta: { total: 42 },
    });
    expect(details!.alerts).toHaveLength(ALERT_CARD_ROW_CAP);
    expect(details!.total).toBe(42);
    expect(details!.capacity).toBeNull();
  });

  it("falls back to the page's own length for the total, and is undefined for a non-list", () => {
    expect(alertListCardDetails({ data: [alert()] })!.total).toBe(1);
    expect(alertListCardDetails({ data: "nope" })).toBeUndefined();
    expect(alertListCardDetails(null)).toBeUndefined();
    expect(alertListCardDetails("Error calling list_alerts")).toBeUndefined();
  });
});

describe("alertDetailCardDetails", () => {
  it("carries the row plus the rule's filters, renotify, no-data mode and the panel's facts", () => {
    const details = alertDetailCardDetails(
      alert({
        filters: [{ field: "environment", op: "=", value: "production" }],
        renotify: { mode: "EVERY", interval_minutes: 60 },
        no_data_mode: "HOLD",
        alerted_at: "2026-09-11T14:35:00Z",
        last_notify_status: "DELIVERED",
        last_notify_at: "2026-09-11T14:35:10Z",
      }),
    );
    expect(details).toEqual({
      kind: "alert_detail",
      alert: expect.objectContaining({
        id: "al-1",
        filters: [{ field: "environment", op: "=", value: "production" }],
        renotify: { mode: "EVERY", interval_minutes: 60 },
        no_data_mode: "HOLD",
        severity_changed_at: "2026-09-11T14:35:00Z",
        alerted_at: "2026-09-11T14:35:00Z",
        last_notify_status: "DELIVERED",
        last_notify_at: "2026-09-11T14:35:10Z",
        creator: "Ada",
        create_time: "2026-09-04T10:00:00Z",
      }),
    });
  });

  it("reads a malformed rule as empty parts rather than failing the card", () => {
    const details = alertDetailCardDetails(alert({ filters: "none", renotify: "off" }));
    expect(details!.alert.filters).toEqual([]);
    expect(details!.alert.renotify).toBeNull();
    expect(details!.alert.no_data_mode).toBeNull();
  });

  it("is undefined when the payload is not an alert", () => {
    expect(alertDetailCardDetails({ detail: "Alert not found" })).toBeUndefined();
    expect(alertDetailCardDetails(undefined)).toBeUndefined();
  });
});
