/**
 * Calls each of the 24 exposed tools over MCP and compares the result with a
 * baseline: the pinned `traceroot-cli --json` for 20 tools, a plain HTTP request
 * to the public API for the 4 the CLI does not cover. Exits non-zero on any
 * difference outside the allow-list in parity-cases.ts.
 *
 *   pnpm --filter @traceroot/mcp parity --url http://localhost:8200/mcp --key tr-… \
 *     [--host http://localhost:8000] [--only get_trace] [--run-id <evaluation run id>]
 *
 * --host is the public API the CLI and the HTTP baseline call (default
 * TRACEROOT_HOST_URL); --run-id seeds get_evaluation_run, which has no list tool.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { CASES, NORMALISE, type ParityCase, type Seeds } from "./parity-cases.js";

const run = promisify(execFile);
const { values } = parseArgs({
  options: {
    url: { type: "string" },
    key: { type: "string", default: process.env.TRACEROOT_API_KEY },
    host: { type: "string", default: process.env.TRACEROOT_HOST_URL },
    only: { type: "string" },
    "run-id": { type: "string", default: process.env.PARITY_RUN_ID },
  },
});
const { url, key, host, only } = values;
if (!url || !key || !host) {
  throw new Error(
    "--url, --key (or TRACEROOT_API_KEY) and --host (or TRACEROOT_HOST_URL) are required",
  );
}
const cliBin = new URL("../node_modules/.bin/traceroot", import.meta.url).pathname;
// A clean HOME so no stored login outranks the key.
const home = mkdtempSync(join(tmpdir(), "parity-home-"));

const client = new Client({ name: "traceroot-mcp-parity", version: "0.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  }),
);

async function mcp(tool: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name: tool, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? "";
  if (result.isError) throw new Error(`MCP error: ${text}`);
  return JSON.parse(text);
}

async function cli(argv: string[]): Promise<unknown> {
  const { stdout } = await run(cliBin, [...argv, "--json"], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      NO_COLOR: "1",
      TRACEROOT_API_KEY: key,
      TRACEROOT_HOST_URL: host,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

/** Independent of the registry engine: a hand-built request, not dispatch(). */
async function http(baseline: {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}) {
  const target = new URL(`/api/v1/public${baseline.path}`, host);
  for (const [name, value] of Object.entries(baseline.query ?? {}))
    target.searchParams.set(name, value);
  const response = await fetch(target, {
    method: baseline.method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(baseline.body ? { "content-type": "application/json" } : {}),
    },
    body: baseline.body ? JSON.stringify(baseline.body) : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function drop(value: unknown, names: string[]): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => !names.includes(name)));
}

function normalise(value: unknown, entries: (keyof typeof NORMALISE)[] = []): unknown {
  return entries.reduce((acc, name) => drop(acc, [...NORMALISE[name].drop]), value);
}

/** Canonical JSON: keys sorted at every depth. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(value), null, 1);
}

function firstDifference(a: string, b: string): string {
  const x = a.split("\n");
  const y = b.split("\n");
  const i = x.findIndex((line, n) => line !== y[n]);
  return `line ${i + 1}: mcp ${JSON.stringify(x[i])} vs baseline ${JSON.stringify(y[i])}`;
}

const first = (value: unknown, list: string, id: string): string | undefined => {
  const rows = (value as Record<string, Record<string, string>[] | undefined> | undefined)?.[list];
  return rows?.[0]?.[id];
};

async function seeds(): Promise<Seeds> {
  const end = new Date();
  end.setSeconds(0, 0);
  const s: Seeds = {
    start: new Date(end.getTime() - 24 * 3600_000).toISOString(),
    end: end.toISOString(),
    runId: values["run-id"],
  };
  const read = async (tool: string, args: Record<string, unknown> = {}) =>
    mcp(tool, args).catch(() => undefined) as Promise<unknown>;
  const findings = await read("list_findings", { limit: 1 });
  Object.assign(s, {
    traceId: first(await read("list_traces", { limit: 1 }), "data", "trace_id"),
    sessionId: first(await read("list_sessions", { limit: 1 }), "data", "session_id"),
    findingId: first(findings, "data", "finding_id"),
    findingTraceId: first(findings, "data", "trace_id"),
    detectorId: first(await read("list_detectors", { limit: 1 }), "data", "detector_id"),
    alertId: first(await read("list_alerts", { limit: 1 }), "data", "id"),
    dashboardId: first(await read("list_dashboards"), "data", "id"),
    datasetId: first(await read("list_datasets", { limit: 1 }), "datasets", "dataset_id"),
  });
  if (s.dashboardId)
    s.widgetId = first(
      await read("get_dashboard", { dashboard_id: s.dashboardId }),
      "widgets",
      "id",
    );
  if (s.datasetId) {
    s.versionId = first(
      await read("list_dataset_versions", { dataset_id: s.datasetId, limit: 1 }),
      "versions",
      "dataset_version_id",
    );
  }
  return s;
}

type Verdict = {
  label: string;
  tool: string;
  baseline: string;
  status: "PASS" | "FAIL" | "SKIP";
  detail: string;
};

async function check(c: ParityCase, s: Seeds): Promise<Verdict> {
  const baseline = c.cli ? "cli" : "http";
  const verdict = (status: Verdict["status"], detail = ""): Verdict => ({
    label: c.label,
    tool: c.tool,
    baseline,
    status,
    detail,
  });
  const args = c.args(s);
  if (args === null) return verdict("SKIP", "no seed data for this call");
  try {
    const [fromMcp, fromBaseline] = await Promise.all([
      mcp(c.tool, args),
      c.cli ? cli(c.cli(s)) : http(c.http!(s)),
    ]);
    const left = canonical(normalise(fromMcp, c.normaliseBoth));
    const right = canonical(normalise(normalise(fromBaseline, c.normaliseCli), c.normaliseBoth));
    return left === right ? verdict("PASS") : verdict("FAIL", firstDifference(left, right));
  } catch (error) {
    return verdict("FAIL", error instanceof Error ? error.message.split("\n")[0]! : String(error));
  }
}

const seed = await seeds();
const verdicts: Verdict[] = [];
for (const c of CASES.filter((c) => !only || c.tool === only)) verdicts.push(await check(c, seed));
await client.close();

const width = Math.max(...verdicts.map((v) => v.label.length));
for (const v of verdicts)
  console.log(
    `${v.status}  ${v.label.padEnd(width)}  vs ${v.baseline}${v.detail ? `  ${v.detail}` : ""}`,
  );
const tools = new Set(verdicts.map((v) => v.tool));
const passed = new Set(
  [...tools].filter((t) => verdicts.filter((v) => v.tool === t).every((v) => v.status === "PASS")),
);
console.log(
  `\n${passed.size} of ${tools.size} tools PASS (${verdicts.filter((v) => v.baseline === "cli" && v.status === "PASS").length} cli rows, ${verdicts.filter((v) => v.baseline === "http" && v.status === "PASS").length} http rows)`,
);
process.exit(passed.size === tools.size ? 0 : 1);
