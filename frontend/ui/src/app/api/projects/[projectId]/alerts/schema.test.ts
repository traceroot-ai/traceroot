import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ALERT_NAME_MAX,
  ALERT_RENOTIFY_MAX_MINUTES,
  ALERT_RENOTIFY_MIN_MINUTES,
} from "@traceroot/core";
import {
  ALERT_FILTERS_MAX,
  alertCreateSchema,
  alertPauseSchema,
  alertUpdateSchema,
  firstIssueMessage,
  isAggregationValidForMeasure,
  isMeasureValidForView,
  THRESHOLD_ABS_MAX,
  toAlertFilters,
  type AlertCreateInput,
} from "./schema";

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "P95 latency",
    view: "SPANS",
    measure: "latency",
    aggregation: "p95",
    filters: [{ field: "model_name", op: "=", value: "gpt-4o" }],
    window: "10m",
    thresholdOperator: ">",
    threshold: 500,
    renotify: { mode: "OFF" },
    ...overrides,
  };
}

function firstMessage(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) throw new Error("expected a failed parse");
  return firstIssueMessage(result.error);
}

describe("alertCreateSchema", () => {
  it("accepts a complete rule", () => {
    const result = alertCreateSchema.safeParse(createBody());

    expect(result.success).toBe(true);
  });

  it("accepts a keyed metadata filter and an explicit noDataMode", () => {
    const result = alertCreateSchema.safeParse(
      createBody({
        filters: [{ field: "metadata", key: "tenant", op: "=", value: "acme" }],
        noDataMode: "ZERO",
      }),
    );

    expect(result.success).toBe(true);
  });

  it("rejects an unknown noDataMode but accepts its absence", () => {
    expect(alertCreateSchema.safeParse(createBody({ noDataMode: "PANIC" })).success).toBe(false);
    expect("noDataMode" in createBody()).toBe(false);
    expect(alertCreateSchema.safeParse(createBody()).success).toBe(true);
  });

  it("rejects a missing rule field", () => {
    const body = createBody();
    delete body.window;

    expect(alertCreateSchema.safeParse(body).success).toBe(false);
  });

  describe("name", () => {
    it("trims surrounding whitespace", () => {
      const result = alertCreateSchema.parse(createBody({ name: "  P95 latency  " }));

      expect(result.name).toBe("P95 latency");
    });

    it("rejects an empty or whitespace-only name with the route's message", () => {
      for (const name of ["", "   "]) {
        const result = alertCreateSchema.safeParse(createBody({ name }));

        expect(firstMessage(result)).toBe("name must be a non-empty string");
      }
    });

    it("accepts a name at ALERT_NAME_MAX and rejects one past it", () => {
      expect(
        alertCreateSchema.safeParse(createBody({ name: "a".repeat(ALERT_NAME_MAX) })).success,
      ).toBe(true);
      expect(
        alertCreateSchema.safeParse(createBody({ name: "a".repeat(ALERT_NAME_MAX + 1) })).success,
      ).toBe(false);
    });
  });

  describe("enumerated rule fields", () => {
    it("rejects an unknown view", () => {
      const result = alertCreateSchema.safeParse(createBody({ view: "TRACES" }));

      expect(firstMessage(result)).toBe("Invalid view");
    });

    it("rejects an unknown aggregation", () => {
      const result = alertCreateSchema.safeParse(createBody({ aggregation: "median" }));

      expect(firstMessage(result)).toBe("Invalid aggregation");
    });

    it("rejects an unknown window", () => {
      const result = alertCreateSchema.safeParse(createBody({ window: "15m" }));

      expect(firstMessage(result)).toBe("Invalid window");
    });

    it("rejects an unknown thresholdOperator", () => {
      const result = alertCreateSchema.safeParse(createBody({ thresholdOperator: "~" }));

      expect(firstMessage(result)).toBe("Invalid thresholdOperator");
    });
  });

  describe("threshold", () => {
    it("accepts zero, negatives and both extremes of the storable range", () => {
      for (const threshold of [0, -500.25, THRESHOLD_ABS_MAX, -THRESHOLD_ABS_MAX]) {
        expect(alertCreateSchema.safeParse(createBody({ threshold })).success).toBe(true);
      }
    });

    it("rejects magnitudes the Decimal(65,30) column cannot store", () => {
      for (const threshold of [THRESHOLD_ABS_MAX * 10, -THRESHOLD_ABS_MAX * 10]) {
        expect(alertCreateSchema.safeParse(createBody({ threshold })).success).toBe(false);
      }
    });

    it("rejects non-finite numbers", () => {
      for (const threshold of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        expect(alertCreateSchema.safeParse(createBody({ threshold })).success).toBe(false);
      }
    });
  });

  describe("renotify", () => {
    it("rejects an interval riding along with OFF", () => {
      const result = alertCreateSchema.safeParse(
        createBody({ renotify: { mode: "OFF", intervalMinutes: 60 } }),
      );

      expect(result.success).toBe(false);
    });

    it("accepts EVERY at both interval bounds", () => {
      for (const intervalMinutes of [ALERT_RENOTIFY_MIN_MINUTES, ALERT_RENOTIFY_MAX_MINUTES]) {
        const result = alertCreateSchema.safeParse(
          createBody({ renotify: { mode: "EVERY", intervalMinutes } }),
        );

        expect(result.success).toBe(true);
      }
    });

    it("rejects EVERY outside the bounds, without an interval, or with a fractional one", () => {
      const intervals = [ALERT_RENOTIFY_MIN_MINUTES - 1, ALERT_RENOTIFY_MAX_MINUTES + 1, 1.5];
      for (const intervalMinutes of intervals) {
        const result = alertCreateSchema.safeParse(
          createBody({ renotify: { mode: "EVERY", intervalMinutes } }),
        );

        expect(result.success).toBe(false);
      }
      expect(alertCreateSchema.safeParse(createBody({ renotify: { mode: "EVERY" } })).success).toBe(
        false,
      );
    });

    it("rejects an unknown mode", () => {
      expect(alertCreateSchema.safeParse(createBody({ renotify: { mode: "DAILY" } })).success).toBe(
        false,
      );
    });
  });

  describe("filters", () => {
    it("names the field alerts cannot filter on", () => {
      const result = alertCreateSchema.safeParse(
        createBody({ filters: [{ field: "trace_id", op: "=", value: "abc" }] }),
      );

      expect(firstMessage(result)).toBe('Alerts cannot filter on "trace_id"');
    });

    it("requires a key on a keyed field", () => {
      const result = alertCreateSchema.safeParse(
        createBody({ filters: [{ field: "metadata", op: "=", value: "acme" }] }),
      );

      expect(firstMessage(result)).toBe('Filter on "metadata" requires a key');
    });

    it("rejects an operator the field does not declare", () => {
      const result = alertCreateSchema.safeParse(
        createBody({ filters: [{ field: "is_root", op: "contains", value: "true" }] }),
      );

      expect(firstMessage(result)).toBe('Operator "contains" is not valid for "is_root"');
    });

    it("trims the key, and rejects a key that trims to nothing", () => {
      const parsed = alertCreateSchema.parse(
        createBody({ filters: [{ field: "metadata", key: "  tenant  ", op: "=", value: "acme" }] }),
      );

      expect(parsed.filters[0].key).toBe("tenant");
      expect(
        alertCreateSchema.safeParse(
          createBody({ filters: [{ field: "metadata", key: "   ", op: "=", value: "acme" }] }),
        ).success,
      ).toBe(false);
    });

    it("rejects a property the filter shape does not declare", () => {
      const result = alertCreateSchema.safeParse(
        createBody({ filters: [{ field: "model_name", op: "=", value: "gpt-4o", keey: "x" }] }),
      );

      expect(result.success).toBe(false);
    });

    it("accepts a finite numeric value and rejects a non-finite one", () => {
      expect(
        alertCreateSchema.safeParse(
          createBody({ filters: [{ field: "model_name", op: "=", value: 4 }] }),
        ).success,
      ).toBe(true);

      const result = alertCreateSchema.safeParse(
        createBody({ filters: [{ field: "model_name", op: "=", value: Number.NaN }] }),
      );
      expect(result.success).toBe(false);
    });

    it("rejects an empty string value", () => {
      expect(
        alertCreateSchema.safeParse(
          createBody({ filters: [{ field: "model_name", op: "=", value: "" }] }),
        ).success,
      ).toBe(false);
    });

    it("accepts ALERT_FILTERS_MAX rows and rejects one more", () => {
      const filter = { field: "model_name", op: "=", value: "gpt-4o" };
      const atMax = Array.from({ length: ALERT_FILTERS_MAX }, () => filter);

      expect(alertCreateSchema.safeParse(createBody({ filters: atMax })).success).toBe(true);
      expect(alertCreateSchema.safeParse(createBody({ filters: [...atMax, filter] })).success).toBe(
        false,
      );
    });
  });
});

describe("alertUpdateSchema", () => {
  it("accepts an empty patch and a single-field patch", () => {
    expect(alertUpdateSchema.safeParse({}).success).toBe(true);
    expect(alertUpdateSchema.safeParse({ name: "Renamed" }).success).toBe(true);
  });

  it("still validates the fields a patch does carry", () => {
    expect(alertUpdateSchema.safeParse({ window: "15m" }).success).toBe(false);
    expect(
      alertUpdateSchema.safeParse({ filters: [{ field: "metadata", op: "=", value: "x" }] })
        .success,
    ).toBe(false);
  });
});

describe("alertPauseSchema", () => {
  it("accepts each declared status and rejects anything else", () => {
    expect(alertPauseSchema.safeParse({ status: "ACTIVE" }).success).toBe(true);
    expect(alertPauseSchema.safeParse({ status: "PAUSED" }).success).toBe(true);
    expect(alertPauseSchema.safeParse({ status: "SNOOZED" }).success).toBe(false);
    expect(alertPauseSchema.safeParse({}).success).toBe(false);
  });
});

describe("firstIssueMessage", () => {
  it("returns the first issue's message", () => {
    const result = alertCreateSchema.safeParse(createBody({ name: "" }));
    if (result.success) throw new Error("expected a failed parse");

    expect(firstIssueMessage(result.error)).toBe("name must be a non-empty string");
  });

  it("falls back when the error carries no issues", () => {
    expect(firstIssueMessage(new z.ZodError([]))).toBe("Invalid request body");
  });
});

describe("isMeasureValidForView", () => {
  it("accepts a measure the view declares", () => {
    expect(isMeasureValidForView("SPANS", "latency")).toBe(true);
    expect(isMeasureValidForView("SPANS", "count")).toBe(true);
  });

  it("rejects an undeclared measure or an unknown view", () => {
    expect(isMeasureValidForView("SPANS", "duration_ms")).toBe(false);
    expect(isMeasureValidForView("TRACES", "latency")).toBe(false);
  });
});

describe("isAggregationValidForMeasure", () => {
  it("accepts combinations the engine can run", () => {
    expect(isAggregationValidForMeasure("SPANS", "latency", "p95")).toBe(true);
    expect(isAggregationValidForMeasure("SPANS", "count", "count")).toBe(true);
    expect(isAggregationValidForMeasure("SPANS", "unique_user_ids", "uniq")).toBe(true);
  });

  it("rejects an unknown view or aggregation before consulting the engine", () => {
    expect(isAggregationValidForMeasure("TRACES", "latency", "p95")).toBe(false);
    expect(isAggregationValidForMeasure("SPANS", "latency", "median")).toBe(false);
  });

  it("rejects an aggregation the measure's type cannot carry", () => {
    expect(isAggregationValidForMeasure("SPANS", "count", "sum")).toBe(false);
    expect(isAggregationValidForMeasure("SPANS", "unique_user_ids", "count")).toBe(false);
  });

  it("routes a unique-id measure out of reach once filters apply", () => {
    const filters = [{ field: "model_name", op: "=", value: "gpt-4o" }];

    expect(isAggregationValidForMeasure("SPANS", "unique_user_ids", "uniq", filters)).toBe(false);
    expect(isAggregationValidForMeasure("SPANS", "latency", "p95", filters)).toBe(true);
  });
});

describe("toAlertFilters", () => {
  it("keeps the key on a keyed field and drops it from a field that takes none", () => {
    const filters: AlertCreateInput["filters"] = [
      { field: "metadata", key: "tenant", op: "=", value: "acme" },
      { field: "model_name", key: "tenant", op: "=", value: "gpt-4o" },
      { field: "status", op: "=", value: "error" },
    ];

    expect(toAlertFilters(filters)).toEqual([
      { field: "metadata", key: "tenant", op: "=", value: "acme" },
      { field: "model_name", op: "=", value: "gpt-4o" },
      { field: "status", op: "=", value: "error" },
    ]);
  });

  it("never puts an undefined key on the stored row", () => {
    const [stored] = toAlertFilters([{ field: "model_name", op: "=", value: "gpt-4o" }]);

    expect("key" in stored).toBe(false);
  });
});
