/**
 * The deterministic ClickHouse dataset the dashboard-read scenarios assert on.
 *
 * A fixture project with no spans can only prove the agent reads *something*;
 * every figure in its answer is "no data". Seeding a known shape turns the
 * read scenarios into real assertions: the spike day's token total, which
 * model costs more, how many errors and when.
 *
 * The builder is pure and takes its anchor date as an argument — no clock is
 * read inside it — so the same anchor always produces byte-identical rows and
 * a unit test can pin the exact figures a scenario is allowed to expect.
 *
 * Row shape mirrors the backend's ingest writer (`db/clickhouse/client.py`).
 * `traces` is a plain ReplacingMergeTree, not a view over `spans`, so both
 * tables are written; `source = 'user'` and `is_evaluation = 0` are what the
 * read path's customer-traffic filter requires, so seeded rows are invisible
 * without them.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FetchLike } from "./types.js";

const execFileAsync = promisify(execFile);

const DAY_MS = 86_400_000;

/**
 * UTC hour a seeded day's traffic starts at.
 *
 * Midnight, so a preset window is deterministic regardless of when the run
 * starts. A "7d" window opens at `now - 7 days`, which falls *inside* the
 * seventh day back — put the traffic at 09:00 and that day counts only for
 * runs started before 09:00 UTC, making a 7d total 18,000 tokens some
 * mornings and 21,000 the rest of the time. Starting each day at 00:00 puts
 * the seventh day's rows before the window opens every time.
 */
const DAY_START_HOUR = 0;
/** Spacing between traces within a day, so a day's rows are ordered but distinct. */
const TRACE_SPACING_MS = 7 * 60_000;

/** Days of history, ending on the day before the anchor (offsets 1..SEED_DAYS). */
export const SEED_DAYS = 89;

/**
 * How far back a read can actually reach on the shortest plan.
 *
 * The backend clamps every window to the workspace's retention before it
 * scans (free = 15 days), and answers with `clamped: true` rather than an
 * error — so on a free workspace a "90d" ask silently becomes a fortnight.
 * The full 89 days are still seeded, because a longer-retention workspace
 * reads them, but every feature a scenario asserts on lives inside this
 * window so the dataset works on any plan.
 */
export const SEED_READABLE_DAYS = 14;

/** A quiet day: the baseline every day carries unless it is named below. */
export const SEED_QUIET_TRACES = 2;
export const SEED_QUIET_TOKENS = 3_000;

/**
 * The spike: one day, far enough back that a 7d window misses it and near
 * enough that the shortest retention still reaches it.
 */
export const SEED_SPIKE_OFFSET_DAYS = 8;
export const SEED_SPIKE_TRACES = 25;
export const SEED_SPIKE_TOKENS = 219_292;

/** The second, smaller bump — outside a 7d window, inside the readable one. */
export const SEED_BUMP_OFFSET_DAYS = 12;
export const SEED_BUMP_TRACES = 9;
export const SEED_BUMP_TOKENS = 84_120;

/**
 * How many of a day's traces fail, by day offset.
 *
 * One error span per failing trace (the second LLM call), so a trace's
 * `error_count` is exactly 1 and "failing traces" and "error spans" are the
 * same number. The root span stays OK: a trace that recorded a failed model
 * call is not itself a second error.
 */
export const SEED_ERRORS_BY_OFFSET: Readonly<Record<number, number>> = {
  2: 1,
  [SEED_SPIKE_OFFSET_DAYS]: 5,
  11: 2,
};

/** What a failing span reports, so an error is legible without opening the row. */
export const SEED_ERROR_MESSAGE = "upstream model call timed out";

/** Milliseconds a failing trace takes — well clear of every healthy one. */
export const SEED_ERROR_DURATION_MS = 31_000;

/**
 * The two models, priced in whole micro-dollars per token so cost is exact
 * integer arithmetic rather than a float that rounds differently per run.
 * The expensive one costs 7.5x the cheap one — a gap no rounding can blur.
 */
export interface SeedModel {
  name: string;
  microDollarsPerToken: number;
}

export const SEED_CHEAP_MODEL: SeedModel = { name: "eval-mini-1", microDollarsPerToken: 2 };
export const SEED_EXPENSIVE_MODEL: SeedModel = { name: "eval-max-1", microDollarsPerToken: 15 };

/** Names carried by every seeded row, so a scenario can name what it expects. */
export const SEED_TRACE_NAME = "eval_workflow";
export const SEED_ENVIRONMENT = "production";
/** Distinct `user_id`s the traces cycle through. */
export const SEED_USER_COUNT = 3;

/** A `default.traces` row, in the column names ClickHouse receives. */
export interface SeedTraceRow {
  trace_id: string;
  project_id: string;
  trace_start_time: string;
  name: string;
  user_id: string;
  session_id: string;
  environment: string;
  source: "user";
  is_evaluation: 0;
}

/** A `default.spans` row, in the column names ClickHouse receives. */
export interface SeedSpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  project_id: string;
  span_start_time: string;
  span_end_time: string;
  name: string;
  span_kind: string;
  status: string;
  status_message: string | null;
  model_name: string | null;
  cost: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  usage_details: Record<string, number>;
  environment: string;
  source: "user";
  is_evaluation: 0;
}

export interface SeedDataset {
  traces: SeedTraceRow[];
  spans: SeedSpanRow[];
}

/** What one day of the dataset contains, before it is expanded into rows. */
export interface SeedDayPlan {
  /** Days before the anchor's UTC date; 1 is "yesterday". */
  offsetDays: number;
  /** The day's UTC date, as `YYYY-MM-DD`. */
  date: string;
  traceCount: number;
  totalTokens: number;
  errorTraces: number;
}

/** UTC midnight of the anchor's date, minus `offsetDays` whole days. */
function dayStart(anchor: Date, offsetDays: number): Date {
  const midnight = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return new Date(midnight - offsetDays * DAY_MS);
}

/** ClickHouse's DateTime64(3) text form: `YYYY-MM-DD HH:MM:SS.mmm`, always UTC. */
export function formatClickHouseDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace("Z", "");
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** FNV-1a over the seed string; the id generator's only source of entropy. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A hex id of `chars` digits, derived only from `key`.
 *
 * Trace and span ids have to look like real ones (hex, right length) and stay
 * identical across runs of the same project, so they are hashed rather than
 * randomly generated — a rerun that reseeds the same project overwrites its
 * own rows instead of doubling them.
 */
export function seedHexId(key: string, chars: number): string {
  let out = "";
  for (let round = 0; out.length < chars; round += 1) {
    out += fnv1a(`${key}#${round}`).toString(16).padStart(8, "0");
  }
  return out.slice(0, chars);
}

/** The day-by-day plan for an anchor: the shape, before it becomes rows. */
export function planSeedDays(anchor: Date): SeedDayPlan[] {
  const plans: SeedDayPlan[] = [];
  for (let offsetDays = 1; offsetDays <= SEED_DAYS; offsetDays += 1) {
    const spike = offsetDays === SEED_SPIKE_OFFSET_DAYS;
    const bump = offsetDays === SEED_BUMP_OFFSET_DAYS;
    plans.push({
      offsetDays,
      date: isoDate(dayStart(anchor, offsetDays)),
      traceCount: spike ? SEED_SPIKE_TRACES : bump ? SEED_BUMP_TRACES : SEED_QUIET_TRACES,
      totalTokens: spike ? SEED_SPIKE_TOKENS : bump ? SEED_BUMP_TOKENS : SEED_QUIET_TOKENS,
      errorTraces: SEED_ERRORS_BY_OFFSET[offsetDays] ?? 0,
    });
  }
  return plans;
}

/**
 * Split a day's token budget across its traces, exactly.
 *
 * The remainder lands on the first trace rather than being spread, so the
 * day's sum is the planned number to the token and a test can pin it.
 */
export function splitTokens(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const shares = Array.from({ length: parts }, () => base);
  shares[0] += total - base * parts;
  return shares;
}

/** Micro-dollars rendered as the fixed-point decimal ClickHouse stores. */
export function formatCost(microDollars: number): string {
  const sign = microDollars < 0 ? "-" : "";
  const whole = Math.trunc(Math.abs(microDollars) / 1_000_000);
  const fraction = Math.abs(microDollars) % 1_000_000;
  return `${sign}${whole}.${String(fraction).padStart(6, "0")}`;
}

/** A healthy trace's wall time: five deterministic values, none near the error one. */
function healthyDurationMs(traceIndex: number): number {
  return 400 + (traceIndex % 5) * 150;
}

/**
 * Build every row for a project, from an anchor date supplied by the caller.
 *
 * Pure: no clock, no randomness, no I/O. The same `(projectId, anchor)` pair
 * always yields the same rows, ids included.
 */
export function buildSeedRows({
  projectId,
  anchor,
}: {
  projectId: string;
  anchor: Date;
}): SeedDataset {
  const traces: SeedTraceRow[] = [];
  const spans: SeedSpanRow[] = [];

  for (const plan of planSeedDays(anchor)) {
    const start = dayStart(anchor, plan.offsetDays).getTime() + DAY_START_HOUR * 3_600_000;
    const tokensPerTrace = splitTokens(plan.totalTokens, plan.traceCount);

    for (let index = 0; index < plan.traceCount; index += 1) {
      const failing = index < plan.errorTraces;
      // Alternating, so both models appear on every day including the quiet
      // ones — a model breakdown is never empty for a window with any traffic.
      const model = index % 2 === 0 ? SEED_CHEAP_MODEL : SEED_EXPENSIVE_MODEL;
      const traceId = seedHexId(`${projectId}|trace|${plan.date}|${index}`, 32);
      const traceStart = start + index * TRACE_SPACING_MS;
      const durationMs = failing ? SEED_ERROR_DURATION_MS : healthyDurationMs(index);

      traces.push({
        trace_id: traceId,
        project_id: projectId,
        trace_start_time: formatClickHouseDateTime(new Date(traceStart)),
        name: SEED_TRACE_NAME,
        user_id: `eval-user-${index % SEED_USER_COUNT}`,
        session_id: `eval-session-${plan.date}`,
        environment: SEED_ENVIRONMENT,
        source: "user",
        is_evaluation: 0,
      });

      const rootId = seedHexId(`${projectId}|span|${plan.date}|${index}|root`, 16);
      // The root carries no model, tokens or cost: it is the trace's envelope,
      // and giving it totals would double-count every child it contains.
      spans.push({
        span_id: rootId,
        trace_id: traceId,
        parent_span_id: null,
        project_id: projectId,
        span_start_time: formatClickHouseDateTime(new Date(traceStart)),
        span_end_time: formatClickHouseDateTime(new Date(traceStart + durationMs)),
        name: SEED_TRACE_NAME,
        span_kind: "SPAN",
        status: "OK",
        status_message: null,
        model_name: null,
        cost: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        usage_details: {},
        environment: SEED_ENVIRONMENT,
        source: "user",
        is_evaluation: 0,
      });

      // Two LLM children per trace, splitting the trace's token budget and
      // nested inside the root's window so the trace duration stays the root's.
      const firstHalf = Math.ceil(tokensPerTrace[index] / 2);
      const childTokens = [firstHalf, tokensPerTrace[index] - firstHalf];
      const childWindows = [
        [50, Math.floor(durationMs * 0.45)],
        [Math.floor(durationMs * 0.5), durationMs - 20],
      ];

      for (let child = 0; child < childTokens.length; child += 1) {
        const total = childTokens[child];
        const output = Math.floor(total / 5);
        const errored = failing && child === childTokens.length - 1;
        spans.push({
          span_id: seedHexId(`${projectId}|span|${plan.date}|${index}|${child}`, 16),
          trace_id: traceId,
          parent_span_id: rootId,
          project_id: projectId,
          span_start_time: formatClickHouseDateTime(new Date(traceStart + childWindows[child][0])),
          span_end_time: formatClickHouseDateTime(new Date(traceStart + childWindows[child][1])),
          name: `chat ${model.name}`,
          span_kind: "LLM",
          status: errored ? "ERROR" : "OK",
          status_message: errored ? SEED_ERROR_MESSAGE : null,
          model_name: model.name,
          cost: formatCost(total * model.microDollarsPerToken),
          input_tokens: total - output,
          output_tokens: output,
          total_tokens: total,
          usage_details: { cache_read_tokens: 0, cache_write_tokens: 0 },
          environment: SEED_ENVIRONMENT,
          source: "user",
          is_evaluation: 0,
        });
      }
    }
  }

  return { traces, spans };
}

/** The figures a scenario is allowed to expect, derived from the same anchor. */
export interface SeedFacts {
  /** UTC date of the spike day, `YYYY-MM-DD`. */
  spikeDate: string;
  spikeTotalTokens: number;
  spikeTraces: number;
  /** UTC date of the smaller bump. */
  bumpDate: string;
  bumpTotalTokens: number;
  /** Every day the dataset covers, newest first. */
  dates: string[];
  totalTraces: number;
  totalSpans: number;
  totalTokens: number;
  /** Total cost across the whole dataset, as the decimal ClickHouse stores. */
  totalCost: string;
  errorSpans: number;
  /** UTC dates carrying at least one error, oldest first. */
  errorDates: string[];
  models: { cheap: string; expensive: string };
  /**
   * Tokens a rolling 7-day window ending at the anchor sees. The window opens
   * at the anchor's time of day seven days back, so the boundary day counts
   * only the traces that started after it opened.
   */
  weekTokens: number;
}

/**
 * Tokens a rolling window of `days` ending at the anchor sees, trace by trace.
 *
 * Presets resolve to `now - N days`, so the boundary day is split at the
 * anchor's time of day: a run started at 00:03 UTC sees a 00:07 trace of the
 * seventh day back, a run at noon does not. Computing it from the anchor keeps
 * a scenario's expected total honest at any hour, to within the minutes
 * between the anchor and the query itself: a run anchored in the first
 * TRACE_SPACING_MS after UTC midnight can still see the backend's later
 * `now` drop a boundary trace the anchor counted.
 */
export function windowTokens(anchor: Date, days: number): number {
  const opens = anchor.getTime() - days * 86_400_000;
  let sum = 0;
  for (const plan of planSeedDays(anchor)) {
    const start = dayStart(anchor, plan.offsetDays).getTime() + DAY_START_HOUR * 3_600_000;
    splitTokens(plan.totalTokens, plan.traceCount).forEach((tokens, index) => {
      if (start + index * TRACE_SPACING_MS >= opens) sum += tokens;
    });
  }
  return sum;
}

/** Everything a scenario can assert about a seeded project, for one anchor. */
export function seedFacts(anchor: Date): SeedFacts {
  const plans = planSeedDays(anchor);
  const { traces, spans } = buildSeedRows({ projectId: "facts", anchor });
  const microDollars = spans.reduce(
    (sum, span) => sum + (span.cost === null ? 0 : Math.round(Number(span.cost) * 1_000_000)),
    0,
  );

  return {
    spikeDate: isoDate(dayStart(anchor, SEED_SPIKE_OFFSET_DAYS)),
    spikeTotalTokens: SEED_SPIKE_TOKENS,
    spikeTraces: SEED_SPIKE_TRACES,
    bumpDate: isoDate(dayStart(anchor, SEED_BUMP_OFFSET_DAYS)),
    bumpTotalTokens: SEED_BUMP_TOKENS,
    dates: plans.map((plan) => plan.date),
    totalTraces: traces.length,
    totalSpans: spans.length,
    totalTokens: plans.reduce((sum, plan) => sum + plan.totalTokens, 0),
    totalCost: formatCost(microDollars),
    errorSpans: plans.reduce((sum, plan) => sum + plan.errorTraces, 0),
    errorDates: plans
      .filter((plan) => plan.errorTraces > 0)
      .map((plan) => plan.date)
      .sort(),
    models: { cheap: SEED_CHEAP_MODEL.name, expensive: SEED_EXPENSIVE_MODEL.name },
    weekTokens: windowTokens(anchor, 7),
  };
}

// --- writing it to ClickHouse ------------------------------------------------

export interface ClickHouseConfig {
  url: string;
  user: string;
  password: string;
  database: string;
  /** Container the docker fallback runs `clickhouse-client` in. */
  container: string;
}

/**
 * ClickHouse connection details from the environment the harness already
 * loads (`dotenv -e ../../../.env`), so the seeder needs no config of its own.
 * `CLICKHOUSE_PORT` is the HTTP port — the same one the backend's client uses.
 */
export function clickHouseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ClickHouseConfig {
  const host = env.CLICKHOUSE_HOST || "localhost";
  const port = env.CLICKHOUSE_PORT || "8123";
  return {
    url: env.CLICKHOUSE_URL || `http://${host}:${port}`,
    user: env.CLICKHOUSE_USER || "default",
    password: env.CLICKHOUSE_PASSWORD || "",
    database: env.CLICKHOUSE_DATABASE || "default",
    // The compose default; a checkout whose compose project is named after
    // its directory sets CLICKHOUSE_CONTAINER instead.
    container: env.CLICKHOUSE_CONTAINER || "traceroot-clickhouse-1",
  };
}

/** Injection points, so the unit tests never open a socket or spawn a process. */
export interface SeedIo {
  config?: ClickHouseConfig;
  fetchImpl?: FetchLike;
  /** Stands in for `docker exec … clickhouse-client`, used only if HTTP fails. */
  execImpl?: (
    file: string,
    args: string[],
    options: { input?: string },
  ) => Promise<{ stdout: string }>;
}

async function execDocker(
  file: string,
  args: string[],
  options: { input?: string },
): Promise<{ stdout: string }> {
  const child = execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024 });
  if (options.input !== undefined) {
    child.child.stdin?.end(options.input);
  }
  const { stdout } = await child;
  return { stdout: String(stdout) };
}

function settingsQuery(config: ClickHouseConfig, statement: string): string {
  const params = new URLSearchParams({ database: config.database, query: statement });
  return `${config.url.replace(/\/+$/, "")}/?${params.toString()}`;
}

/**
 * Run one statement, preferring ClickHouse's HTTP interface.
 *
 * HTTP is what a local run without any container tooling has, so it is tried
 * first; the `docker exec` fallback exists for a stack whose HTTP port is not
 * published. A statement rejected by ClickHouse (a 4xx/5xx with a body) is a
 * real error and is not retried through docker — only a failure to reach it
 * at all falls back.
 */
export async function runClickHouseStatement(
  statement: string,
  body: string | undefined,
  io: SeedIo = {},
): Promise<string> {
  const config = io.config ?? clickHouseConfigFromEnv();
  const fetchImpl = io.fetchImpl ?? ((url, init) => fetch(url, init));

  let response: Response;
  try {
    response = await fetchImpl(settingsQuery(config, statement), {
      method: "POST",
      headers: {
        "X-ClickHouse-User": config.user,
        "X-ClickHouse-Key": config.password,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: body ?? "",
    });
  } catch {
    const exec = io.execImpl ?? execDocker;
    const { stdout } = await exec(
      "docker",
      [
        "exec",
        "-i",
        config.container,
        "clickhouse-client",
        `--user=${config.user}`,
        `--password=${config.password}`,
        `--database=${config.database}`,
        "--query",
        statement,
      ],
      { input: body },
    );
    return stdout;
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`ClickHouse rejected the statement (${response.status}): ${text.trim()}`);
  }
  return text;
}

/** Rows as the newline-delimited JSON ClickHouse's JSONEachRow format expects. */
export function toJsonEachRow(rows: unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

/** Write a built dataset. Traces first, so a half-written project is never spans-only. */
export async function insertSeedRows(dataset: SeedDataset, io: SeedIo = {}): Promise<void> {
  await runClickHouseStatement(
    "INSERT INTO traces FORMAT JSONEachRow",
    toJsonEachRow(dataset.traces),
    io,
  );
  await runClickHouseStatement(
    "INSERT INTO spans FORMAT JSONEachRow",
    toJsonEachRow(dataset.spans),
    io,
  );
}

/**
 * Build and write the dataset for a project.
 *
 * `anchor` is the caller's clock, passed in rather than read here, so a run's
 * dates and its assertions come from one instant.
 */
export async function seedProject(
  projectId: string,
  anchor: Date,
  io: SeedIo = {},
): Promise<SeedDataset> {
  const dataset = buildSeedRows({ projectId, anchor });
  await insertSeedRows(dataset, io);
  return dataset;
}

/**
 * The statement that removes a project's seeded rows from one table.
 *
 * `ALTER TABLE … DELETE`, not a lightweight `DELETE`: both tables are
 * ReplacingMergeTree and `spans` carries a projection, where the mutation is
 * the supported path. `project_id` is quoted here rather than bound because
 * ClickHouse's HTTP parameters are per-request, not per-statement, and the
 * value is a uuid the harness generated — never user text.
 */
export function deleteStatement(table: string, projectId: string): string {
  return `ALTER TABLE ${table} DELETE WHERE project_id = ${quoteProjectId(projectId)} SETTINGS mutations_sync = 2`;
}

/**
 * The project id as a ClickHouse string literal, after checking it is one.
 *
 * The delete above is the one statement here that can touch rows the harness
 * did not write, so an empty or odd-looking id is refused rather than compiled
 * into `WHERE project_id = ''`.
 */
function quoteProjectId(projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
    throw new Error(
      `refusing to touch ClickHouse rows for project id ${JSON.stringify(projectId)}`,
    );
  }
  return `'${projectId}'`;
}

/** Remove everything seeded for a project, from both tables. */
export async function unseedProject(projectId: string, io: SeedIo = {}): Promise<void> {
  await runClickHouseStatement(deleteStatement("spans", projectId), undefined, io);
  await runClickHouseStatement(deleteStatement("traces", projectId), undefined, io);
}

/** How many rows a project still has, per table — the teardown check. */
export async function countSeededRows(
  projectId: string,
  io: SeedIo = {},
): Promise<{ traces: number; spans: number }> {
  const read = async (table: string): Promise<number> => {
    const text = await runClickHouseStatement(
      `SELECT count() FROM ${table} WHERE project_id = ${quoteProjectId(projectId)}`,
      undefined,
      io,
    );
    return Number(text.trim());
  };
  return { traces: await read("traces"), spans: await read("spans") };
}
