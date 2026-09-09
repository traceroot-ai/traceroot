import { describe, expect, it, vi } from "vitest";
import {
  windowTokens,
  buildSeedRows,
  clickHouseConfigFromEnv,
  countSeededRows,
  deleteStatement,
  formatClickHouseDateTime,
  formatCost,
  insertSeedRows,
  planSeedDays,
  runClickHouseStatement,
  SEED_BUMP_OFFSET_DAYS,
  SEED_BUMP_TOKENS,
  SEED_CHEAP_MODEL,
  SEED_DAYS,
  SEED_ERROR_MESSAGE,
  SEED_ERRORS_BY_OFFSET,
  SEED_EXPENSIVE_MODEL,
  SEED_QUIET_TOKENS,
  SEED_READABLE_DAYS,
  SEED_SPIKE_OFFSET_DAYS,
  SEED_SPIKE_TOKENS,
  seedFacts,
  seedHexId,
  seedProject,
  splitTokens,
  toJsonEachRow,
  unseedProject,
  type ClickHouseConfig,
  type SeedSpanRow,
} from "../seed.js";

/** A mid-afternoon anchor, so "the anchor's UTC date" is unambiguous. */
const ANCHOR = new Date("2026-09-08T16:30:00.000Z");
const PROJECT = "proj-eval";

const CONFIG: ClickHouseConfig = {
  url: "http://ch.test:8123",
  user: "ch-user",
  password: "ch-pass",
  database: "default",
  container: "ch-container",
};

/** The statement a recorded request carried, as ClickHouse would read it. */
function statementOf(url: string): string {
  return new URL(url).searchParams.get("query") ?? "";
}

/** A fetch that always answers 200, recording what it was called with. */
function okFetch(body = "") {
  return vi.fn(async (_url: string, _init?: RequestInit) => new Response(body, { status: 200 }));
}

function spansOn(rows: SeedSpanRow[], date: string): SeedSpanRow[] {
  return rows.filter((span) => span.span_start_time.startsWith(date));
}

function sumTokens(rows: SeedSpanRow[]): number {
  return rows.reduce((total, span) => total + (span.total_tokens ?? 0), 0);
}

describe("buildSeedRows", () => {
  it("is a pure function of its project and anchor", () => {
    const first = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const second = buildSeedRows({ projectId: PROJECT, anchor: new Date(ANCHOR) });
    expect(second).toEqual(first);
  });

  it("reads no clock: the same UTC day at a different hour seeds the same dates", () => {
    const morning = buildSeedRows({ projectId: PROJECT, anchor: new Date("2026-09-08T00:01:00Z") });
    const evening = buildSeedRows({ projectId: PROJECT, anchor: new Date("2026-09-08T23:59:00Z") });
    expect(evening.spans.map((s) => s.span_start_time)).toEqual(
      morning.spans.map((s) => s.span_start_time),
    );
  });

  it("varies the ids by project, so two fixtures never share a row", () => {
    const a = buildSeedRows({ projectId: "proj-a", anchor: ANCHOR });
    const b = buildSeedRows({ projectId: "proj-b", anchor: ANCHOR });
    expect(a.traces[0].trace_id).not.toBe(b.traces[0].trace_id);
  });

  it("gives every span and trace a unique id", () => {
    const { traces, spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    expect(new Set(spans.map((s) => s.span_id)).size).toBe(spans.length);
    expect(new Set(traces.map((t) => t.trace_id)).size).toBe(traces.length);
  });

  it("covers the days before the anchor and never the anchor day itself", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const dates = [...new Set(spans.map((s) => s.span_start_time.slice(0, 10)))].sort();
    expect(dates).toHaveLength(SEED_DAYS);
    expect(dates.at(-1)).toBe("2026-09-07");
    expect(dates[0]).toBe("2026-06-11");
    expect(dates).not.toContain("2026-09-08");
  });

  it("starts each day at midnight, so a preset window covers the same days at any hour", () => {
    // A 7d window opens mid-day seven days back: traffic later in the day
    // would fall inside it only for runs started early enough, which is a
    // different total for the same dataset.
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const firstOfDay = spans.filter((s) => s.span_start_time.endsWith("00:00:00.000"));
    expect(firstOfDay.length).toBe(SEED_DAYS);

    const sevenDaysBack = (at: Date) => {
      const opens = at.getTime() - 7 * 86_400_000;
      return sumTokens(
        buildSeedRows({ projectId: PROJECT, anchor: at }).spans.filter(
          (s) => new Date(`${s.span_start_time}Z`).getTime() >= opens,
        ),
      );
    };
    expect(sevenDaysBack(new Date("2026-09-08T00:30:00Z"))).toBe(
      sevenDaysBack(new Date("2026-09-08T21:30:00Z")),
    );
  });

  it("puts every span strictly in the past of the anchor", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    for (const span of spans) {
      expect(new Date(`${span.span_end_time}Z`).getTime()).toBeLessThan(ANCHOR.getTime());
    }
  });

  it("counts a rolling week trace by trace, so the boundary day depends on the hour", () => {
    // Six quiet days always fit; the seventh day back only contributes the
    // traces that started after the window opened at the anchor's time of day.
    const noon = new Date("2026-09-08T12:00:00.000Z");
    expect(windowTokens(noon, 7)).toBe(6 * 3_000);
    const justAfterMidnight = new Date("2026-09-08T00:03:00.000Z");
    expect(windowTokens(justAfterMidnight, 7)).toBe(6 * 3_000 + 1_500);
    expect(seedFacts(noon).weekTokens).toBe(windowTokens(noon, 7));
  });

  it("sums the spike day to exactly the published figure", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const facts = seedFacts(ANCHOR);
    expect(facts.spikeDate).toBe("2026-08-31");
    expect(sumTokens(spansOn(spans, facts.spikeDate))).toBe(SEED_SPIKE_TOKENS);
    expect(SEED_SPIKE_TOKENS).toBe(219_292);
  });

  it("sums the second bump to its own figure, well under the spike", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const facts = seedFacts(ANCHOR);
    expect(sumTokens(spansOn(spans, facts.bumpDate))).toBe(SEED_BUMP_TOKENS);
    expect(SEED_BUMP_TOKENS).toBeLessThan(SEED_SPIKE_TOKENS / 2);
  });

  it("keeps every other day quiet, so the spike is unmistakable", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const facts = seedFacts(ANCHOR);
    const quiet = facts.dates.filter((d) => d !== facts.spikeDate && d !== facts.bumpDate);
    for (const date of quiet) {
      expect(sumTokens(spansOn(spans, date))).toBe(SEED_QUIET_TOKENS);
    }
    expect(SEED_SPIKE_TOKENS / SEED_QUIET_TOKENS).toBeGreaterThan(50);
  });

  it("puts every assertable feature outside a 7d window but inside retention", () => {
    // Two constraints at once: a 7d ask must honestly miss the spike (so a
    // scenario can tell reading the window from reciting the dataset), and
    // nothing asserted on may fall past the shortest plan's retention clamp,
    // which silently shortens even a 90d ask.
    for (const offset of [SEED_SPIKE_OFFSET_DAYS, SEED_BUMP_OFFSET_DAYS]) {
      expect(offset).toBeGreaterThan(7);
      expect(offset).toBeLessThanOrEqual(SEED_READABLE_DAYS);
    }
    for (const offset of Object.keys(SEED_ERRORS_BY_OFFSET).map(Number)) {
      expect(offset).toBeLessThanOrEqual(SEED_READABLE_DAYS);
    }
  });

  it("gives each trace a root span with no parent and no totals", () => {
    const { traces, spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const roots = spans.filter((span) => span.parent_span_id === null);
    expect(roots).toHaveLength(traces.length);
    for (const root of roots) {
      expect(root.total_tokens).toBeNull();
      expect(root.cost).toBeNull();
      expect(root.model_name).toBeNull();
      expect(root.span_kind).toBe("SPAN");
    }
  });

  it("hangs two LLM children off every root, inside its window", () => {
    const { traces, spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const children = spans.filter((span) => span.parent_span_id !== null);
    expect(children).toHaveLength(traces.length * 2);

    const roots = new Map(
      spans.filter((s) => s.parent_span_id === null).map((s) => [s.span_id, s]),
    );
    for (const child of children) {
      const root = roots.get(child.parent_span_id as string);
      expect(root).toBeDefined();
      expect(child.span_kind).toBe("LLM");
      expect(child.span_start_time >= (root as SeedSpanRow).span_start_time).toBe(true);
      expect(child.span_end_time <= (root as SeedSpanRow).span_end_time).toBe(true);
    }
  });

  it("keeps a trace's input and output tokens adding up to its total", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    for (const span of spans.filter((s) => s.total_tokens !== null)) {
      expect((span.input_tokens ?? 0) + (span.output_tokens ?? 0)).toBe(span.total_tokens);
    }
  });

  it("uses two models, the second one clearly more expensive per token", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const models = new Set(spans.map((s) => s.model_name).filter(Boolean));
    expect([...models].sort()).toEqual([SEED_EXPENSIVE_MODEL.name, SEED_CHEAP_MODEL.name].sort());

    const costPerToken = (name: string) => {
      const rows = spans.filter((s) => s.model_name === name);
      const cost = rows.reduce((sum, s) => sum + Number(s.cost), 0);
      return cost / sumTokens(rows);
    };
    expect(costPerToken(SEED_EXPENSIVE_MODEL.name)).toBeGreaterThan(
      costPerToken(SEED_CHEAP_MODEL.name) * 5,
    );
  });

  it("puts both models on every day, so a breakdown is never single-valued", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    for (const date of seedFacts(ANCHOR).dates) {
      const models = new Set(
        spansOn(spans, date)
          .map((s) => s.model_name)
          .filter(Boolean),
      );
      expect(models.size).toBe(2);
    }
  });

  it("fails exactly one span per failing trace, on the named days only", () => {
    const { spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const errors = spans.filter((span) => span.status === "ERROR");
    const expected = Object.values(SEED_ERRORS_BY_OFFSET).reduce((a, b) => a + b, 0);
    expect(errors).toHaveLength(expected);

    const byTrace = new Map<string, number>();
    for (const span of errors) byTrace.set(span.trace_id, (byTrace.get(span.trace_id) ?? 0) + 1);
    expect([...byTrace.values()].every((count) => count === 1)).toBe(true);

    const facts = seedFacts(ANCHOR);
    expect([...new Set(errors.map((s) => s.span_start_time.slice(0, 10)))].sort()).toEqual(
      facts.errorDates,
    );
    for (const span of errors) expect(span.status_message).toBe(SEED_ERROR_MESSAGE);
  });

  it("marks every row as customer traffic, which the read path filters on", () => {
    const { traces, spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    for (const row of [...traces, ...spans]) {
      expect(row.source).toBe("user");
      expect(row.is_evaluation).toBe(0);
      expect(row.project_id).toBe(PROJECT);
    }
  });

  it("writes one traces row per root span, starting when the root does", () => {
    const { traces, spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    const roots = spans.filter((span) => span.parent_span_id === null);
    const starts = new Map(traces.map((t) => [t.trace_id, t.trace_start_time]));
    expect(starts.size).toBe(roots.length);
    for (const root of roots) expect(starts.get(root.trace_id)).toBe(root.span_start_time);
  });
});

describe("planSeedDays", () => {
  it("plans one entry per day, newest first, none on the anchor day", () => {
    const plans = planSeedDays(ANCHOR);
    expect(plans).toHaveLength(SEED_DAYS);
    expect(plans[0]).toMatchObject({ offsetDays: 1, date: "2026-09-07" });
    expect(plans.at(-1)).toMatchObject({ offsetDays: SEED_DAYS });
  });

  it("crosses a month boundary without drifting", () => {
    expect(planSeedDays(new Date("2026-03-02T04:00:00Z"))[1].date).toBe("2026-02-28");
  });
});

describe("splitTokens", () => {
  it("distributes the whole budget, remainder on the first share", () => {
    expect(splitTokens(219_292, 25).reduce((a, b) => a + b, 0)).toBe(219_292);
    expect(splitTokens(10, 4)).toEqual([4, 2, 2, 2]);
  });
});

describe("formatCost", () => {
  it("renders micro-dollars as a fixed six-decimal string", () => {
    expect(formatCost(1_578_780)).toBe("1.578780");
    expect(formatCost(2)).toBe("0.000002");
    expect(formatCost(0)).toBe("0.000000");
  });
});

describe("formatClickHouseDateTime", () => {
  it("renders millisecond UTC without the T or the Z", () => {
    expect(formatClickHouseDateTime(new Date("2026-08-31T09:00:00.250Z"))).toBe(
      "2026-08-31 09:00:00.250",
    );
  });
});

describe("seedHexId", () => {
  it("returns lowercase hex of the requested length, stable per key", () => {
    expect(seedHexId("k", 32)).toMatch(/^[0-9a-f]{32}$/);
    expect(seedHexId("k", 16)).toBe(seedHexId("k", 16));
    expect(seedHexId("k", 16)).not.toBe(seedHexId("k2", 16));
  });
});

describe("seedFacts", () => {
  it("reports the totals the rows actually carry", () => {
    const facts = seedFacts(ANCHOR);
    const { traces, spans } = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    expect(facts.totalTraces).toBe(traces.length);
    expect(facts.totalSpans).toBe(spans.length);
    expect(facts.totalTokens).toBe(sumTokens(spans));
    expect(facts.spikeTotalTokens).toBe(SEED_SPIKE_TOKENS);
    expect(facts.models).toEqual({
      cheap: SEED_CHEAP_MODEL.name,
      expensive: SEED_EXPENSIVE_MODEL.name,
    });
  });

  it("pins the figures a scenario may assert", () => {
    // Change these and every scenario asserting a number has to change too.
    expect(seedFacts(ANCHOR)).toMatchObject({
      spikeDate: "2026-08-31",
      spikeTotalTokens: 219_292,
      spikeTraces: 25,
      bumpDate: "2026-08-27",
      bumpTotalTokens: 84_120,
      totalTraces: 208,
      totalSpans: 624,
      totalTokens: 564_412,
      errorSpans: 8,
      errorDates: ["2026-08-28", "2026-08-31", "2026-09-06"],
    });
  });
});

describe("clickHouseConfigFromEnv", () => {
  it("builds the HTTP url from the backend's own connection variables", () => {
    expect(
      clickHouseConfigFromEnv({
        CLICKHOUSE_HOST: "ch.internal",
        CLICKHOUSE_PORT: "9123",
        CLICKHOUSE_USER: "u",
        CLICKHOUSE_PASSWORD: "p",
        CLICKHOUSE_DATABASE: "traces",
      } as NodeJS.ProcessEnv),
    ).toEqual({
      url: "http://ch.internal:9123",
      user: "u",
      password: "p",
      database: "traces",
      container: "traceroot-clickhouse-1",
    });
  });

  it("falls back to the local stack's defaults", () => {
    expect(clickHouseConfigFromEnv({} as NodeJS.ProcessEnv)).toMatchObject({
      url: "http://localhost:8123",
      database: "default",
    });
  });
});

describe("runClickHouseStatement", () => {
  it("posts the statement as a query parameter and the rows as the body", async () => {
    const fetchImpl = okFetch("ok");
    await runClickHouseStatement("INSERT INTO spans FORMAT JSONEachRow", '{"a":1}', {
      config: CONFIG,
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("http://ch.test:8123/?");
    expect(statementOf(url)).toBe("INSERT INTO spans FORMAT JSONEachRow");
    expect(new URL(url).searchParams.get("database")).toBe("default");
    expect(init?.body).toBe('{"a":1}');
    expect(init?.headers).toMatchObject({
      "X-ClickHouse-User": "ch-user",
      "X-ClickHouse-Key": "ch-pass",
    });
  });

  it("surfaces a rejected statement with the server's own message", async () => {
    const fetchImpl = vi.fn(async () => new Response("Code 62: Syntax error", { status: 400 }));
    await expect(
      runClickHouseStatement("NOPE", undefined, { config: CONFIG, fetchImpl }),
    ).rejects.toThrow(/400.*Syntax error/);
  });

  it("does not retry a rejected statement through docker", async () => {
    const execImpl = vi.fn(async () => ({ stdout: "" }));
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 500 }));
    await expect(
      runClickHouseStatement("NOPE", undefined, { config: CONFIG, fetchImpl, execImpl }),
    ).rejects.toThrow();
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("falls back to the container client when HTTP cannot be reached", async () => {
    const execImpl = vi.fn(async () => ({ stdout: "42\n" }));
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const out = await runClickHouseStatement("SELECT count()", "rows", {
      config: CONFIG,
      fetchImpl,
      execImpl,
    });

    expect(out).toBe("42\n");
    const [file, args, options] = execImpl.mock.calls[0] as unknown as [
      string,
      string[],
      { input?: string; env?: NodeJS.ProcessEnv },
    ];
    expect(file).toBe("docker");
    expect(args).toContain("ch-container");
    expect(args).toContain("--query");
    expect(args.at(-1)).toBe("SELECT count()");
    expect(options.input).toBe("rows");
    // The credential rides in the environment, never in argv.
    expect(args.join(" ")).not.toContain(CONFIG.password);
    expect(args.slice(args.indexOf("-e"), args.indexOf("-e") + 2)).toEqual([
      "-e",
      "CLICKHOUSE_PASSWORD",
    ]);
    expect(options.env?.CLICKHOUSE_PASSWORD).toBe(CONFIG.password);
  });
});

describe("toJsonEachRow", () => {
  it("renders one JSON object per line", () => {
    expect(toJsonEachRow([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}');
  });
});

describe("insertSeedRows", () => {
  it("writes traces before spans, each in its own statement", async () => {
    const fetchImpl = okFetch();
    const dataset = buildSeedRows({ projectId: PROJECT, anchor: ANCHOR });
    await insertSeedRows(dataset, { config: CONFIG, fetchImpl });

    const statements = fetchImpl.mock.calls.map(([url]) => statementOf(url));
    expect(statements).toEqual([
      "INSERT INTO traces FORMAT JSONEachRow",
      "INSERT INTO spans FORMAT JSONEachRow",
    ]);

    const spanBody = fetchImpl.mock.calls[1][1]?.body as string;
    expect(spanBody.split("\n")).toHaveLength(dataset.spans.length);
    expect(JSON.parse(spanBody.split("\n")[0])).toMatchObject({ project_id: PROJECT });
  });
});

describe("seedProject", () => {
  it("returns the rows it wrote, built from the anchor it was given", async () => {
    const fetchImpl = okFetch();
    const dataset = await seedProject(PROJECT, ANCHOR, { config: CONFIG, fetchImpl });
    expect(dataset).toEqual(buildSeedRows({ projectId: PROJECT, anchor: ANCHOR }));
  });
});

describe("deleteStatement", () => {
  it("mutates synchronously and scopes strictly to the project", () => {
    const sql = deleteStatement("spans", "proj-1");
    expect(sql).toBe(
      "ALTER TABLE spans DELETE WHERE project_id = 'proj-1' SETTINGS mutations_sync = 2",
    );
  });

  it("refuses an id that could not have been generated, rather than quoting it", () => {
    expect(() => deleteStatement("spans", "a'b")).toThrow(/refusing/);
    expect(() => deleteStatement("spans", "")).toThrow(/refusing/);
    expect(() => deleteStatement("spans", "x' OR 1=1 --")).toThrow(/refusing/);
    expect(deleteStatement("spans", "32d81a27-fdc7-4193-be8c-19bff3054d70")).toContain(
      "project_id = '32d81a27-fdc7-4193-be8c-19bff3054d70'",
    );
  });
});

describe("unseedProject", () => {
  it("clears both tables", async () => {
    const fetchImpl = okFetch();
    await unseedProject("proj-1", { config: CONFIG, fetchImpl });
    const statements = fetchImpl.mock.calls.map(([url]) => statementOf(url));
    expect(statements[0]).toContain("ALTER TABLE spans DELETE WHERE project_id = 'proj-1'");
    expect(statements[1]).toContain("ALTER TABLE traces DELETE WHERE project_id = 'proj-1'");
  });
});

describe("countSeededRows", () => {
  it("reports what each table still holds for the project", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("3\n", { status: 200 }))
      .mockResolvedValueOnce(new Response("9\n", { status: 200 }));
    await expect(countSeededRows("proj-1", { config: CONFIG, fetchImpl })).resolves.toEqual({
      traces: 3,
      spans: 9,
    });
  });
});
