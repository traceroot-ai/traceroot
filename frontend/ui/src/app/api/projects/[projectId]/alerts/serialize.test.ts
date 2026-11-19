import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mockFindMany = vi.fn();

vi.mock("@traceroot/core", () => ({
  prisma: { user: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

import {
  alertSelect,
  alertSummarySelect,
  decimalToNumber,
  serializeAlert,
  withCreators,
  type AlertRow,
  type AlertSummaryRow,
} from "./serialize";

/** What the list has to know to tell a broken rule from a healthy one. */
const HEALTH_FIELDS = [
  "lastError",
  "lastErrorAt",
  "lastNotifyStatus",
  "lastNotifyError",
  "lastNotifyAt",
] as const;

function summaryRow(overrides: Record<string, unknown> = {}): AlertSummaryRow {
  return {
    id: "alert-1",
    name: "P95 latency",
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    window: "10m",
    thresholdOperator: ">",
    threshold: new Prisma.Decimal("500.000"),
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
    createTime: new Date("2026-07-01T00:00:00.000Z"),
    updateTime: new Date("2026-07-01T00:00:00.000Z"),
    createdBy: "user-1",
    ...overrides,
  } as unknown as AlertSummaryRow;
}

function fullRow(overrides: Record<string, unknown> = {}): AlertRow {
  return {
    ...summaryRow(),
    filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
    renotify: { mode: "EVERY", intervalMinutes: 60 },
    noDataMode: "HOLD",
    ...overrides,
  } as unknown as AlertRow;
}

beforeEach(() => {
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValue([]);
});

describe("decimalToNumber", () => {
  it("renders a Decimal as a plain number and passes a number through untouched", () => {
    expect(decimalToNumber(new Prisma.Decimal("500.000"))).toBe(500);
    expect(decimalToNumber(new Prisma.Decimal("-12.25"))).toBe(-12.25);
    expect(decimalToNumber(0)).toBe(0);
    expect(decimalToNumber(-1.5)).toBe(-1.5);
  });

  it("produces a value JSON renders as a number, not an object", () => {
    expect(JSON.stringify({ threshold: decimalToNumber(new Prisma.Decimal("500.000")) })).toBe(
      '{"threshold":500}',
    );
  });
});

describe("withCreators", () => {
  it("falls back to the email when the account has no name", async () => {
    mockFindMany.mockResolvedValue([{ id: "user-1", name: "", email: "ada@example.com" }]);

    const [alert] = await withCreators([summaryRow()]);

    expect(alert.creator).toBe("ada@example.com");
  });

  it("renders a creator that resolves to no user as null", async () => {
    mockFindMany.mockResolvedValue([]);

    const [alert] = await withCreators([summaryRow({ createdBy: "deleted-user" })]);

    expect(alert.creator).toBeNull();
  });

  it("looks the whole page up in one deduplicated query", async () => {
    mockFindMany.mockResolvedValue([{ id: "user-1", name: "Ada", email: "ada@example.com" }]);

    await withCreators([
      summaryRow({ id: "a" }),
      summaryRow({ id: "b" }),
      summaryRow({ id: "c", createdBy: "user-2" }),
    ]);

    expect(mockFindMany).toHaveBeenCalledTimes(1);
    expect(mockFindMany.mock.calls[0][0].where.id.in).toEqual(["user-1", "user-2"]);
  });

  it("resolves each row against its own creator", async () => {
    mockFindMany.mockResolvedValue([
      { id: "user-1", name: "Ada", email: "ada@example.com" },
      { id: "user-2", name: "Grace", email: "grace@example.com" },
    ]);

    const alerts = await withCreators([summaryRow(), summaryRow({ createdBy: "user-2" })]);

    expect(alerts.map((a) => a.creator)).toEqual(["Ada", "Grace"]);
  });

  it("replaces the raw createdBy id with the resolved creator", async () => {
    mockFindMany.mockResolvedValue([{ id: "user-1", name: "Ada", email: "ada@example.com" }]);

    const [alert] = await withCreators([summaryRow()]);

    expect("createdBy" in alert).toBe(false);
    expect(alert.threshold).toBe(500);
  });

  it("issues no rows and still queries safely for an empty page", async () => {
    expect(await withCreators([])).toEqual([]);
    expect(mockFindMany.mock.calls[0][0].where.id.in).toEqual([]);
  });

  it("keeps the summary's evaluation clocks", async () => {
    mockFindMany.mockResolvedValue([{ id: "user-1", name: "Ada", email: "ada@example.com" }]);
    const lastEvaluatedAt = new Date("2026-08-01T00:01:00.000Z");

    const [alert] = await withCreators([summaryRow({ severity: "ALERT", lastEvaluatedAt })]);

    expect(alert.severity).toBe("ALERT");
    expect(alert.lastEvaluatedAt).toBe(lastEvaluatedAt);
  });

  it("carries the rule's health, without which a broken rule reads as a healthy one", async () => {
    mockFindMany.mockResolvedValue([{ id: "user-1", name: "Ada", email: "ada@example.com" }]);
    const lastErrorAt = new Date("2026-08-01T00:02:00.000Z");
    const lastNotifyAt = new Date("2026-08-01T00:03:00.000Z");

    const [alert] = await withCreators([
      summaryRow({
        lastError: "ClickHouse read timeout",
        lastErrorAt,
        lastNotifyStatus: "FAILED",
        lastNotifyError: "channel revoked",
        lastNotifyAt,
      }),
    ]);

    expect(alert.lastError).toBe("ClickHouse read timeout");
    expect(alert.lastErrorAt).toBe(lastErrorAt);
    expect(alert.lastNotifyStatus).toBe("FAILED");
    expect(alert.lastNotifyError).toBe("channel revoked");
    expect(alert.lastNotifyAt).toBe(lastNotifyAt);
  });

  it("reports a healthy rule's health fields as empty rather than dropping them", async () => {
    mockFindMany.mockResolvedValue([{ id: "user-1", name: "Ada", email: "ada@example.com" }]);

    const [alert] = await withCreators([summaryRow()]);

    for (const field of HEALTH_FIELDS) {
      expect(field in alert).toBe(true);
      expect(alert[field]).toBeNull();
    }
  });
});

describe("serializeAlert", () => {
  it("adds the rule fields the summary omits", async () => {
    mockFindMany.mockResolvedValue([{ id: "user-1", name: "Ada", email: "ada@example.com" }]);

    const alert = await serializeAlert(fullRow());

    expect(alert.filters).toEqual([{ field: "model_name", op: "=", value: "gpt-4o" }]);
    expect(alert.renotify).toEqual({ mode: "EVERY", intervalMinutes: 60 });
    expect(alert.noDataMode).toBe("HOLD");
    expect(alert.creator).toBe("Ada");
    expect(alert.threshold).toBe(500);
    expect("createdBy" in alert).toBe(false);
  });

  it("carries the same health fields the list carries", async () => {
    const alert = await serializeAlert(fullRow({ lastError: "ClickHouse read timeout" }));

    expect(alert.lastError).toBe("ClickHouse read timeout");
    for (const field of HEALTH_FIELDS) {
      expect(field in alert).toBe(true);
    }
  });
});

describe("select shapes", () => {
  it("keeps the fields only one rule at a time needs off the list select", () => {
    expect("filters" in alertSummarySelect).toBe(false);
    expect("renotify" in alertSummarySelect).toBe(false);
    expect("noDataMode" in alertSummarySelect).toBe(false);
  });

  it("adds only those three to the detail select", () => {
    expect(alertSelect).toEqual({
      ...alertSummarySelect,
      filters: true,
      renotify: true,
      noDataMode: true,
    });
  });

  it("selects createdBy so a creator can be resolved", () => {
    expect(alertSummarySelect.createdBy).toBe(true);
  });

  it("selects every health field, so the list can show a rule that is not reporting", () => {
    for (const field of HEALTH_FIELDS) {
      expect(alertSummarySelect[field]).toBe(true);
      expect(alertSelect[field]).toBe(true);
    }
  });
});
