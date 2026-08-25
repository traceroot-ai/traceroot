/**
 * Fixtures for the alerts end-to-end suite.
 *
 * Talks to the real dev stack: Postgres through Prisma, ClickHouse over its
 * HTTP interface, the REST backend's internal evaluator over HTTP. Nothing here
 * is mocked; the two process boundaries the scenarios stub (the Redis queue
 * and the Slack client) are stubbed in the test file with `vi.mock`, because
 * module mocks must be declared there.
 *
 * Every scenario works inside one workspace/project pair minted per suite run,
 * so parallel runs on a shared database cannot see each other's rows, and
 * `teardown` removes the pair (Postgres cascades; ClickHouse spans are deleted
 * by project id).
 */
import { randomUUID } from "node:crypto";
import {
  encryptKey,
  prisma,
  type AlertFilter,
  type AlertNoDataMode,
  type AlertThresholdOperator,
  type AlertWindow,
} from "@traceroot/core";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface E2EEnv {
  backendUrl: string;
  internalSecret: string;
  clickhouseUrl: string;
  clickhouseUser: string;
  clickhousePassword: string;
  clickhouseDatabase: string;
  /** Set both to deliver to a real Slack channel instead of the fake client. */
  slackBotToken: string | undefined;
  slackChannelId: string | undefined;
}

export function readEnv(): E2EEnv {
  const host = process.env.CLICKHOUSE_HOST || "localhost";
  const port = process.env.CLICKHOUSE_PORT || "8123";
  return {
    backendUrl: process.env.BACKEND_INTERNAL_URL || "http://localhost:8000",
    internalSecret: process.env.INTERNAL_API_SECRET || "",
    clickhouseUrl: process.env.CLICKHOUSE_URL || `http://${host}:${port}`,
    clickhouseUser: process.env.CLICKHOUSE_USER || "clickhouse",
    clickhousePassword: process.env.CLICKHOUSE_PASSWORD || "clickhouse",
    clickhouseDatabase: process.env.CLICKHOUSE_DATABASE || "default",
    slackBotToken: process.env.E2E_SLACK_BOT_TOKEN || undefined,
    slackChannelId: process.env.E2E_SLACK_CHANNEL_ID || undefined,
  };
}

/**
 * Fail the suite up front, with a message naming the missing service, rather
 * than letting the first scenario time out against a socket.
 */
export async function preflight(env: E2EEnv): Promise<void> {
  const problems: string[] = [];

  if (!process.env.DATABASE_URL) problems.push("DATABASE_URL is not set");
  if (!process.env.ENCRYPTION_KEY) problems.push("ENCRYPTION_KEY is not set");
  if (!env.internalSecret) problems.push("INTERNAL_API_SECRET is not set");

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    problems.push(`Postgres unreachable via DATABASE_URL: ${describe(error)}`);
  }

  try {
    const pong = await clickhouseQuery(env, "SELECT 1");
    if (pong.trim() !== "1") problems.push(`ClickHouse answered unexpectedly: ${pong}`);
  } catch (error) {
    problems.push(`ClickHouse unreachable at ${env.clickhouseUrl}: ${describe(error)}`);
  }

  try {
    const response = await fetch(`${env.backendUrl}/health`);
    if (!response.ok) problems.push(`REST backend /health returned ${response.status}`);
  } catch (error) {
    problems.push(`REST backend unreachable at ${env.backendUrl}: ${describe(error)}`);
  }

  if (problems.length > 0) {
    throw new Error(
      `alerts e2e preflight failed:\n  - ${problems.join("\n  - ")}\n` +
        "Start the stack with `make dev` (or see src/alerts/__e2e__/README.md).",
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// ClickHouse
// ---------------------------------------------------------------------------

function clickhouseHeaders(env: E2EEnv): Record<string, string> {
  return {
    "X-ClickHouse-User": env.clickhouseUser,
    "X-ClickHouse-Key": env.clickhousePassword,
    "X-ClickHouse-Database": env.clickhouseDatabase,
  };
}

export async function clickhouseQuery(env: E2EEnv, sql: string): Promise<string> {
  const response = await fetch(env.clickhouseUrl, {
    method: "POST",
    headers: clickhouseHeaders(env),
    body: sql,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ClickHouse ${response.status}: ${text}`);
  return text;
}

/** `2026-08-25 09:30:00.000` — what DateTime64(3) accepts over JSONEachRow. */
function chDateTime(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export interface SpanSeed {
  /** Start time; end is start + durationMs. */
  start: Date;
  durationMs?: number;
  name?: string;
  spanKind?: string;
  status?: string;
  modelName?: string | null;
  environment?: string | null;
  cost?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Stored as the `metadata` JSON; ClickHouse materializes `metadata_map` from it. */
  metadata?: Record<string, string>;
  /** Spans of one trace share it; a fresh trace per span when omitted. */
  traceId?: string;
}

/**
 * Insert spans for `projectId` straight into the `spans` table. The columns
 * mirror what ingest writes for a completed span; anything ingest leaves null
 * is left null here too, so the evaluator sees the same shape.
 */
export async function seedSpans(env: E2EEnv, projectId: string, seeds: SpanSeed[]): Promise<void> {
  if (seeds.length === 0) return;
  const now = chDateTime(new Date());
  const rows = seeds.map((seed) => {
    const durationMs = seed.durationMs ?? 100;
    const metadata = seed.metadata ?? {};
    return {
      span_id: randomUUID().replace(/-/g, "").slice(0, 16),
      trace_id: seed.traceId ?? randomUUID().replace(/-/g, ""),
      parent_span_id: null,
      project_id: projectId,
      span_start_time: chDateTime(seed.start),
      span_end_time: chDateTime(new Date(seed.start.getTime() + durationMs)),
      name: seed.name ?? "e2e.root",
      span_kind: seed.spanKind ?? "AGENT",
      status: seed.status ?? "OK",
      status_message: null,
      model_name: seed.modelName ?? null,
      cost: seed.cost ?? null,
      input_tokens: seed.inputTokens ?? null,
      output_tokens: seed.outputTokens ?? null,
      total_tokens:
        seed.inputTokens == null && seed.outputTokens == null
          ? null
          : (seed.inputTokens ?? 0) + (seed.outputTokens ?? 0),
      input: null,
      output: null,
      metadata: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
      git_source_file: null,
      git_source_line: null,
      git_source_function: null,
      ch_create_time: now,
      ch_update_time: now,
      environment: seed.environment ?? null,
      usage_details: {},
      // Customer traffic: every customer-facing read asserts `source = 'user'`.
      source: "user",
      // `metadata_map` is MATERIALIZED from `metadata`, so it is not written;
      // JSONEachRow would drop it silently anyway.
      is_evaluation: 0,
    };
  });
  const body = rows.map((row) => JSON.stringify(row)).join("\n");
  const response = await fetch(
    `${env.clickhouseUrl}/?query=${encodeURIComponent("INSERT INTO spans FORMAT JSONEachRow")}`,
    { method: "POST", headers: clickhouseHeaders(env), body },
  );
  if (!response.ok)
    throw new Error(`ClickHouse insert ${response.status}: ${await response.text()}`);
}

/**
 * A heavy mutation, run synchronously: `spans` carries projections, which rule
 * out the lightweight DELETE. The project id is a value this harness minted,
 * never user input, so interpolating it is safe.
 */
export async function deleteSpans(env: E2EEnv, projectId: string): Promise<void> {
  await clickhouseQuery(
    env,
    `ALTER TABLE spans DELETE WHERE project_id = '${projectId}' SETTINGS mutations_sync = 2`,
  );
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

export interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

/**
 * A user, a workspace on the free plan (which carries the slack-integration
 * entitlement) and one project. The ids are random so a suite can run beside
 * a developer's own data.
 */
export async function createTenant(label: string): Promise<Tenant> {
  const suffix = randomUUID().slice(0, 8);
  const user = await prisma.user.create({
    data: {
      id: `e2e-user-${suffix}`,
      email: `e2e-${suffix}@alerts.test`,
      name: `E2E ${label}`,
    },
  });
  const workspace = await prisma.workspace.create({
    data: { id: `e2e-ws-${suffix}`, name: `E2E ${label}` },
  });
  await prisma.workspaceMember.create({
    data: {
      id: `e2e-member-${suffix}`,
      workspaceId: workspace.id,
      userId: user.id,
      role: "ADMIN",
    },
  });
  const project = await prisma.project.create({
    data: { id: `e2e-proj-${suffix}`, workspaceId: workspace.id, name: `E2E ${label}` },
  });
  return { userId: user.id, workspaceId: workspace.id, projectId: project.id };
}

export async function connectSlack(
  tenant: Tenant,
  options: { channelId: string; channelName?: string; botToken?: string },
): Promise<void> {
  await prisma.slackIntegration.create({
    data: {
      workspaceId: tenant.workspaceId,
      teamId: "T_E2E",
      teamName: "E2E Team",
      botUserId: "U_E2E_BOT",
      botToken: encryptKey(options.botToken ?? "xoxb-e2e-fake-token"),
      channelId: options.channelId,
      channelName: options.channelName ?? "e2e-alerts",
      connectedByUserId: tenant.userId,
    },
  });
}

export interface RuleSeed {
  name: string;
  measure?: string;
  aggregation?: string;
  filters?: AlertFilter[];
  window?: AlertWindow;
  thresholdOperator?: AlertThresholdOperator;
  threshold?: number;
  noDataMode?: AlertNoDataMode;
}

/**
 * A rule as the API's create route would store it: cold state, due now. The
 * default is the count-of-spans rule the manual e2e used: `count > 1` over 1m.
 */
export async function createRule(tenant: Tenant, seed: RuleSeed): Promise<string> {
  const alert = await prisma.alert.create({
    data: {
      projectId: tenant.projectId,
      name: seed.name,
      view: "SPANS",
      measure: seed.measure ?? "count",
      aggregation: seed.aggregation ?? "count",
      filters: (seed.filters ?? []) as unknown as object[],
      window: seed.window ?? "1m",
      thresholdOperator: seed.thresholdOperator ?? ">",
      threshold: seed.threshold ?? 1,
      renotify: { mode: "OFF" },
      noDataMode: seed.noDataMode,
      createdBy: tenant.userId,
      nextRunAt: new Date(0),
    },
    select: { id: true },
  });
  return alert.id;
}

export async function readRule(alertId: string) {
  return prisma.alert.findUniqueOrThrow({
    where: { id: alertId },
    select: {
      severity: true,
      noDataMode: true,
      status: true,
      severityChangedAt: true,
      alertedAt: true,
      lastEvaluatedAt: true,
      nextRunAt: true,
      lastError: true,
      lastNotifyStatus: true,
      lastNotifyError: true,
      lastNotifyAt: true,
    },
  });
}

/** Make the rule claimable again on the next tick without touching its state. */
export async function makeDue(alertId: string): Promise<void> {
  await prisma.alert.update({ where: { id: alertId }, data: { nextRunAt: new Date(0) } });
}

export async function teardown(env: E2EEnv, tenant: Tenant | undefined): Promise<void> {
  if (!tenant) return;
  await deleteSpans(env, tenant.projectId).catch(() => undefined);
  // The workspace cascades to members, projects, alerts and the integration.
  await prisma.workspace.deleteMany({ where: { id: tenant.workspaceId } });
  await prisma.user.deleteMany({ where: { id: tenant.userId } });
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

import { ALERT_EVALUATION_OFFSET_MS, windowToMs } from "@traceroot/core";

/**
 * The window a tick at `now` evaluates for `window`: it ends
 * ALERT_EVALUATION_OFFSET_MS behind the minute boundary (spans still arriving
 * are not judged), so seeded spans have to sit inside `[start, end)`.
 */
export function evaluatedWindow(now: Date, window: AlertWindow = "1m") {
  const boundary = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const end = new Date(boundary.getTime() - ALERT_EVALUATION_OFFSET_MS);
  const start = new Date(end.getTime() - windowToMs(window));
  return { boundary, start, end };
}

/** Evenly spaced instants strictly inside the window. */
export function instantsWithin(window: { start: Date; end: Date }, count: number): Date[] {
  const span = window.end.getTime() - window.start.getTime();
  return Array.from({ length: count }, (_, i) => {
    const fraction = (i + 1) / (count + 1);
    return new Date(window.start.getTime() + Math.floor(span * fraction));
  });
}
