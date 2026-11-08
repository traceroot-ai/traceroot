import type { UpdateWindows, WindowAggregates } from "@traceroot/core/updates";

/**
 * Reads window aggregates from the backend's internal API, which runs the
 * ClickHouse queries. Same arrangement as the other worker readers: the worker
 * holds no ClickHouse credentials of its own.
 */

interface GroupDto {
  name: string;
  traces: number;
  error_traces: number;
  p50_ms: number;
  p95_ms: number;
}

interface AggregatesDto {
  start: string;
  end: string;
  totals: {
    traces: number;
    error_traces: number;
    p50_ms: number;
    p95_ms: number;
    p99_ms: number;
    git_context_traces: number;
  };
  llm: {
    calls: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost: string;
  };
  by_model: { model: string; calls: number; total_tokens: number; cost: string }[];
  by_model_day: { model: string; day: string; total_tokens: number; cost: string }[];
  tools: { name: string; calls: number; errors: number }[];
  workflows: GroupDto[];
  refs: GroupDto[];
  truncated: string[];
}

/** A hung backend must fail the attempt, not hold the run until it is reclaimed. */
const REQUEST_TIMEOUT_MS = 60_000;

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export interface AggregatesClientConfig {
  baseUrl: string;
  secret: string;
  fetchImpl?: FetchLike;
}

export function aggregatesConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AggregatesClientConfig {
  return {
    baseUrl: env.BACKEND_INTERNAL_URL || "http://localhost:8000",
    secret: env.INTERNAL_API_SECRET || "",
  };
}

const toGroup = (g: GroupDto) => ({
  name: g.name,
  traces: g.traces,
  errorTraces: g.error_traces,
  p50Ms: g.p50_ms,
  p95Ms: g.p95_ms,
});

/** The backend sends naive UTC datetimes; say so, so no reader takes them for local time. */
const asUtc = (value: string) => (/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);

export function fromDto(dto: AggregatesDto): WindowAggregates {
  return {
    start: asUtc(dto.start),
    end: asUtc(dto.end),
    totals: {
      traces: dto.totals.traces,
      errorTraces: dto.totals.error_traces,
      p50Ms: dto.totals.p50_ms,
      p95Ms: dto.totals.p95_ms,
      p99Ms: dto.totals.p99_ms,
      gitContextTraces: dto.totals.git_context_traces,
    },
    llm: {
      calls: dto.llm.calls,
      inputTokens: dto.llm.input_tokens,
      outputTokens: dto.llm.output_tokens,
      totalTokens: dto.llm.total_tokens,
      cost: dto.llm.cost,
    },
    byModel: dto.by_model.map((m) => ({
      model: m.model,
      calls: m.calls,
      totalTokens: m.total_tokens,
      cost: m.cost,
    })),
    byModelDay: dto.by_model_day.map((m) => ({
      model: m.model,
      day: m.day,
      totalTokens: m.total_tokens,
      cost: m.cost,
    })),
    tools: dto.tools,
    workflows: dto.workflows.map(toGroup),
    refs: dto.refs.map(toGroup),
    truncated: dto.truncated ?? [],
  };
}

export async function readWindowAggregates(
  config: AggregatesClientConfig,
  projectId: string,
  start: Date,
  end: Date,
  timezone = "UTC",
): Promise<WindowAggregates> {
  const url = new URL("/api/v1/internal/update-aggregates", config.baseUrl);
  url.searchParams.set("project_id", projectId);
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  url.searchParams.set("tz", timezone);
  const doFetch: FetchLike = config.fetchImpl ?? ((u, init) => fetch(u, init));
  const response = await doFetch(url.toString(), {
    headers: { "X-Internal-Secret": config.secret },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      `Aggregates request failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  }
  return fromDto((await response.json()) as AggregatesDto);
}

/** Both windows of a run, read in parallel. */
export async function readRunAggregates(
  config: AggregatesClientConfig,
  projectId: string,
  windows: Pick<UpdateWindows, "windowStart" | "windowEnd" | "prevWindowStart" | "prevWindowEnd">,
  timezone = "UTC",
): Promise<{ current: WindowAggregates; previous: WindowAggregates }> {
  const [current, previous] = await Promise.all([
    readWindowAggregates(config, projectId, windows.windowStart, windows.windowEnd, timezone),
    readWindowAggregates(
      config,
      projectId,
      windows.prevWindowStart,
      windows.prevWindowEnd,
      timezone,
    ),
  ]);
  return { current, previous };
}

export interface SampleTraceDto {
  trace_id: string;
  name: string;
  reason: string;
  failed: boolean;
  duration_ms: number;
  cost: string;
  git_ref: string | null;
  status_message: string | null;
}

async function getJson<T>(config: AggregatesClientConfig, url: URL): Promise<T> {
  const doFetch: FetchLike = config.fetchImpl ?? ((u, init) => fetch(u, init));
  const response = await doFetch(url.toString(), {
    headers: { "X-Internal-Secret": config.secret },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `Backend request failed: ${response.status} ${(await response.text()).slice(0, 200)}`,
    );
  return (await response.json()) as T;
}

/** The fixed, labelled sample of traces for drill-down. The seed makes it repeatable per run. */
export async function readTraceSample(
  config: AggregatesClientConfig,
  projectId: string,
  start: Date,
  end: Date,
  seed: number,
): Promise<SampleTraceDto[]> {
  const url = new URL("/api/v1/internal/update-aggregates/sample", config.baseUrl);
  url.searchParams.set("project_id", projectId);
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());
  url.searchParams.set("seed", String(seed));
  return (await getJson<{ traces: SampleTraceDto[] }>(config, url)).traces;
}

/**
 * The bounded SQL tool. A refusal (no time range, too wide, bad query) comes
 * back as the tool's own message so the model can narrow its question.
 */
export async function runBoundedSql(
  config: AggregatesClientConfig,
  projectId: string,
  query: string,
): Promise<{ columns: string[]; rows: unknown[][]; truncated: boolean }> {
  const doFetch = config.fetchImpl as unknown as typeof fetch | undefined;
  const response = await (doFetch ?? fetch)(
    new URL("/api/v1/internal/update-sql", config.baseUrl).toString(),
    {
      method: "POST",
      headers: { "X-Internal-Secret": config.secret, "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: projectId, query }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (response.status === 422) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    throw new Error(`The query was refused: ${body.detail ?? "invalid query"}`);
  }
  if (!response.ok) throw new Error(`The query failed (${response.status}).`);
  return (await response.json()) as { columns: string[]; rows: unknown[][]; truncated: boolean };
}
