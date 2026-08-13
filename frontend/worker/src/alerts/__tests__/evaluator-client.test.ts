import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AlertFilter } from "@traceroot/core";
import {
  evaluateAlerts,
  isSendableAlertSpec,
  type AlertEvaluationSpec,
} from "../evaluator-client.js";
import { deriveAlertSeverity } from "../state-machine.js";

const specWith = (filters: AlertFilter[]): AlertEvaluationSpec => ({
  alert_id: "alert-1",
  view: "SPANS",
  measure: "latency",
  aggregation: "avg",
  filters,
});

const sendableWith = (value: unknown): boolean =>
  isSendableAlertSpec(
    specWith([{ field: "service_name", op: "=", value } as unknown as AlertFilter]),
  );

describe("isSendableAlertSpec", () => {
  it("accepts the filters the backend model would take, and a spec with none at all", () => {
    expect(
      isSendableAlertSpec(
        specWith([
          { field: "service_name", op: "=", value: "api" },
          { field: "metadata", key: "tenant", op: "contains", value: "acme" },
          { field: "duration_ms", op: "=", value: 250 },
        ]),
      ),
    ).toBe(true);
    expect(isSendableAlertSpec(specWith([]))).toBe(true);
    // Zero and negative are values rather than absences.
    expect(isSendableAlertSpec(specWith([{ field: "cost", op: "=", value: 0 }]))).toBe(true);
    expect(isSendableAlertSpec(specWith([{ field: "cost", op: "=", value: -1 }]))).toBe(true);
  });

  it("rejects an operator outside the engine's vocabulary", () => {
    for (const op of ["in", "any of", "!=", "CONTAINS", ""]) {
      expect(isSendableAlertSpec(specWith([{ field: "service_name", op, value: "api" }]))).toBe(
        false,
      );
    }
  });

  it("rejects an empty field, and a value that is neither string nor finite number", () => {
    expect(isSendableAlertSpec(specWith([{ field: "", op: "=", value: "api" }]))).toBe(false);
    const notFinite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

    for (const value of [...notFinite, "", null, undefined, true, ["api"], { in: ["api"] }]) {
      expect(sendableWith(value)).toBe(false);
    }
  });

  it("rejects the whole spec when only one of its filters is unsendable", () => {
    expect(
      isSendableAlertSpec(
        specWith([
          { field: "service_name", op: "=", value: "api" },
          { field: "status", op: "in", value: "error" },
        ]),
      ),
    ).toBe(false);
  });
});

describe("evaluateAlerts", () => {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>();

  const jsonResponse = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  const request = {
    projectId: "proj-1",
    windowStart: new Date("2026-08-12T10:26:30.000Z"),
    windowEnd: new Date("2026-08-12T10:36:30.000Z"),
    alerts: [specWith([{ field: "service_name", op: "=", value: "api" }])],
  };

  const severityOf = (result: { value: number | null }) =>
    deriveAlertSeverity(result.value, ">", 1);

  const firstResultOf = async (fields: Record<string, unknown>) => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [{ alert_id: "a", ...fields }] }));
    const [result] = await evaluateAlerts(request);
    return result;
  };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the window as ISO instants under the internal secret", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ results: [] }));

    await evaluateAlerts(request);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/v1/internal/alert-evaluate");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Internal-Secret"]).toBe(
      process.env.INTERNAL_API_SECRET || "",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      project_id: "proj-1",
      window_start: "2026-08-12T10:26:30.000Z",
      window_end: "2026-08-12T10:36:30.000Z",
      alerts: request.alerts,
    });
    // A request without a deadline holds a tick's slot open indefinitely.
    expect(init.signal).toBeDefined();
  });

  it("returns the measurement the backend reported, keeping a zero value", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { alert_id: "a", value: 12.5, row_count: 40, error: null },
          // An empty error string is no error.
          { alert_id: "b", value: 0, row_count: 7, error: "" },
        ],
      }),
    );

    const results = await evaluateAlerts(request);

    expect(results).toEqual([
      { alert_id: "a", value: 12.5, row_count: 40, error: null },
      { alert_id: "b", value: 0, row_count: 7, error: null },
    ]);
    expect(severityOf(results[1])).toBe("OK");
  });

  it("reads an unusable value as no data, and judges the rule on the value alone", async () => {
    for (const value of ["12.5", Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const result = await firstResultOf({ value, row_count: 40, error: null });

      expect(result.value).toBeNull();
      // The coercion is invisible on its own: this is what the rule ends up saying.
      expect(severityOf(result)).toBe("NO_DATA");
    }

    for (const row_count of ["40", null, undefined, { toNumber: 40 }]) {
      const result = await firstResultOf({ value: 12.5, row_count, error: null });

      // The count falls back to zero and the measurement beside it still stands:
      // whether the window was empty is the evaluator's answer, in the value.
      expect(result.row_count).toBe(0);
      expect(severityOf(result)).toBe("ALERT");
    }
  });

  it("drops an entry that names no alert, rather than settling the wrong rule", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { value: 1, row_count: 1, error: null },
          "not an object",
          { alert_id: "a", value: 1, row_count: 1, error: null },
        ],
      }),
    );

    expect((await evaluateAlerts(request)).map((result) => result.alert_id)).toEqual(["a"]);
  });

  it("fails the batch when the body carries no results array", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "something else" }));

    await expect(evaluateAlerts(request)).rejects.toThrow(/no results array/);
  });

  it("withholds the response body, which echoes every filter value the user typed", async () => {
    const secretish = "customer-email@example.com";
    const body = JSON.stringify({ detail: [{ input: { value: secretish } }] });
    fetchMock.mockResolvedValue({ ok: false, status: 422, text: async () => body });

    const failure: unknown = await evaluateAlerts(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;

    expect(message).toContain("422");
    expect(message).toContain("withheld");
    expect(message).not.toContain(secretish);
    expect(message).not.toContain("input");
    expect(message).toMatch(/alerts=1/);
  });
});
