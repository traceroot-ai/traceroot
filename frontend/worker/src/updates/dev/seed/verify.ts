import { prisma } from "@traceroot/core";
import { queryText, type ClickHouseTarget } from "./clickhouse-io.js";
import type { buildManifest } from "./manifest.js";

type Manifest = ReturnType<typeof buildManifest>;

const parseNano = (text: string | number): bigint => {
  const [whole, frac = ""] = String(text).split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0").slice(0, 9));
};

async function rows(
  target: ClickHouseTarget,
  sql: string,
): Promise<Record<string, string | number>[]> {
  const text = await queryText(target, `${sql} FORMAT JSONEachRow`);
  return text.trim() === ""
    ? []
    : text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
}

const sqlTime = (iso: string) => iso.replace("T", " ").replace("Z", "");

/**
 * Compare what ClickHouse answers with what the manifest says was planted:
 * counts, errors, percentiles, tokens and cost, overall and by workflow,
 * model, model and day, tool and ref. Returns the differences; empty means the
 * aggregate queries and the seeded ground truth agree exactly.
 */
export async function verifyManifest(
  target: ClickHouseTarget,
  manifest: Manifest,
): Promise<string[]> {
  const problems: string[] = [];
  const check = (label: string, actual: unknown, expected: unknown) => {
    if (String(actual) !== String(expected))
      problems.push(`${label}: expected ${expected}, got ${actual}`);
  };

  for (const [key, project] of Object.entries(manifest.projects)) {
    for (const [windowName, bounds] of [
      ["current", manifest.windows.current],
      ["previous", manifest.windows.previous],
    ] as const) {
      const expected = project.expected[windowName];
      const label = `${key}/${windowName}`;
      const start = sqlTime(bounds.start);
      const end = sqlTime(bounds.end);
      const pid = project.id;
      const inWindowSpans = `project_id = '${pid}' AND span_start_time >= '${start}' AND span_start_time < '${end}'`;
      const inWindowTraces = `project_id = '${pid}' AND trace_start_time >= '${start}' AND trace_start_time < '${end}'`;

      const [totals] = await rows(
        target,
        `SELECT count() AS traces,
                countIf(trace_id IN (SELECT trace_id FROM spans WHERE ${inWindowSpans} AND status = 'ERROR')) AS errors
         FROM traces WHERE ${inWindowTraces}`,
      );
      check(`${label} traces`, totals.traces, expected.traces);
      check(`${label} errorTraces`, totals.errors, expected.errorTraces);

      const [latency] = await rows(
        target,
        `SELECT quantileExact(0.5)(dateDiff('millisecond', span_start_time, span_end_time)) AS p50,
                quantileExact(0.95)(dateDiff('millisecond', span_start_time, span_end_time)) AS p95
         FROM spans WHERE ${inWindowSpans} AND parent_span_id IS NULL`,
      );
      if (expected.traces > 0) {
        check(`${label} p50Ms`, latency.p50, expected.p50Ms);
        check(`${label} p95Ms`, latency.p95, expected.p95Ms);
      }

      const [llm] = await rows(
        target,
        `SELECT count() AS calls, sum(input_tokens) AS input, sum(output_tokens) AS output,
                sum(total_tokens) AS total, sum(cost) AS cost
         FROM spans WHERE ${inWindowSpans} AND span_kind = 'LLM'`,
      );
      check(`${label} llmCalls`, llm.calls, expected.llmCalls);
      if (expected.llmCalls > 0) {
        check(`${label} inputTokens`, llm.input, expected.inputTokens);
        check(`${label} outputTokens`, llm.output, expected.outputTokens);
        check(`${label} totalTokens`, llm.total, expected.totalTokens);
        check(`${label} cost`, parseNano(llm.cost), parseNano(expected.cost));
      }

      const byModel = await rows(
        target,
        `SELECT model_name AS model, count() AS calls, sum(total_tokens) AS total, sum(cost) AS cost
         FROM spans WHERE ${inWindowSpans} AND span_kind = 'LLM' GROUP BY model_name ORDER BY model_name`,
      );
      check(
        `${label} model set`,
        byModel.map((r) => r.model).join(","),
        Object.keys(expected.byModel).join(","),
      );
      for (const r of byModel) {
        const e = expected.byModel[r.model];
        if (!e) continue;
        check(`${label} ${r.model} calls`, r.calls, e.calls);
        check(`${label} ${r.model} tokens`, r.total, e.totalTokens);
        check(`${label} ${r.model} cost`, parseNano(r.cost), parseNano(e.cost));
      }

      const byDay = await rows(
        target,
        `SELECT model_name AS model, toString(toDate(span_start_time)) AS day, sum(total_tokens) AS total, sum(cost) AS cost
         FROM spans WHERE ${inWindowSpans} AND span_kind = 'LLM' GROUP BY model_name, day ORDER BY model_name, day`,
      );
      check(`${label} model-day cells`, byDay.length, Object.keys(expected.byModelDay).length);
      for (const r of byDay) {
        const e = expected.byModelDay[`${r.model}|${r.day}`];
        if (!e) {
          problems.push(`${label} unexpected model-day ${r.model}|${r.day}`);
          continue;
        }
        check(`${label} ${r.model} ${r.day} tokens`, r.total, e.totalTokens);
        check(`${label} ${r.model} ${r.day} cost`, parseNano(r.cost), parseNano(e.cost));
      }

      const tools = await rows(
        target,
        `SELECT name, count() AS calls, countIf(status = 'ERROR') AS errors
         FROM spans WHERE ${inWindowSpans} AND span_kind = 'TOOL' GROUP BY name ORDER BY name`,
      );
      check(
        `${label} tool set`,
        tools.map((r) => r.name).join(","),
        Object.keys(expected.byTool).join(","),
      );
      for (const r of tools) {
        const e = expected.byTool[r.name];
        if (!e) continue;
        check(`${label} tool ${r.name} calls`, r.calls, e.calls);
        check(`${label} tool ${r.name} errors`, r.errors, e.errors);
      }

      const workflows = await rows(
        target,
        `SELECT name, count() AS traces,
                quantileExact(0.5)(dateDiff('millisecond', span_start_time, span_end_time)) AS p50,
                quantileExact(0.95)(dateDiff('millisecond', span_start_time, span_end_time)) AS p95
         FROM spans WHERE ${inWindowSpans} AND parent_span_id IS NULL GROUP BY name ORDER BY name`,
      );
      check(
        `${label} workflow set`,
        workflows.map((r) => r.name).join(","),
        Object.keys(expected.byWorkflow).join(","),
      );
      for (const r of workflows) {
        const e = expected.byWorkflow[r.name];
        if (!e) continue;
        check(`${label} ${r.name} traces`, r.traces, e.traces);
        check(`${label} ${r.name} p50`, r.p50, e.p50Ms);
        check(`${label} ${r.name} p95`, r.p95, e.p95Ms);
      }

      const refs = await rows(
        target,
        `SELECT git_ref AS ref, count() AS traces FROM traces
         WHERE ${inWindowTraces} AND git_ref IS NOT NULL GROUP BY git_ref ORDER BY git_ref`,
      );
      check(`${label} ref count`, refs.length, Object.keys(expected.byRef).length);
      for (const r of refs)
        check(`${label} ref ${r.ref} traces`, r.traces, expected.byRef[r.ref]?.traces);
    }
  }
  return problems;
}

const EXPECTED_PROJECTS = [
  "main",
  "nogit",
  "tiny",
  "empty",
  "other",
  "cloneslow",
  "clonebig",
  "clonedead",
];

/**
 * The Postgres half of the ground truth: the projects and their schedules, and
 * each seeded signal with its hit counts per window. Also refuses a manifest
 * that is missing a project or whose planted changes point at a project it
 * does not list, so an emptied manifest cannot pass.
 */
export async function verifyPostgres(manifest: Manifest): Promise<string[]> {
  const problems: string[] = [];
  const keys = Object.keys(manifest.projects);
  if (keys.slice().sort().join(",") !== EXPECTED_PROJECTS.slice().sort().join(",")) {
    problems.push(
      `manifest projects are ${keys.join(",")}, expected ${EXPECTED_PROJECTS.join(",")}`,
    );
  }
  const ids = new Set(Object.values(manifest.projects).map((p) => p.id));
  for (const change of manifest.plantedChanges) {
    if (!ids.has(change.project))
      problems.push(`planted change ${change.id} names an unknown project`);
  }
  if (manifest.plantedChanges.length === 0) problems.push("manifest lists no planted changes");

  const windows = manifest.windows;
  for (const project of Object.values(manifest.projects)) {
    const schedule = await prisma.projectUpdateSchedule.findUnique({
      where: { projectId: project.id },
    });
    if (!schedule) problems.push(`${project.id}: no update schedule row`);
    for (const signal of project.signals) {
      const hits = await prisma.signalHit.findMany({
        where: { signalId: signal.id },
        select: { seenAt: true },
      });
      const within = (from: string, to: string) =>
        hits.filter((h) => h.seenAt >= new Date(from) && h.seenAt < new Date(to)).length;
      const cur = within(windows.current.start, windows.current.end);
      const prev = within(windows.previous.start, windows.previous.end);
      if (cur !== signal.hitsCurrent)
        problems.push(`${signal.id}: ${cur} hits now, expected ${signal.hitsCurrent}`);
      if (prev !== signal.hitsPrevious)
        problems.push(`${signal.id}: ${prev} hits before, expected ${signal.hitsPrevious}`);
    }
  }
  return problems;
}
