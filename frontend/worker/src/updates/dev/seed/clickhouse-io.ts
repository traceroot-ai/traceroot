import type { SpanRow, TraceRow } from "./types.js";

export interface ClickHouseTarget {
  url: string;
  user: string;
  password: string;
  database: string;
}

/** Connection details from the same variables the rest of the stack reads. */
export function clickHouseTargetFromEnv(env: NodeJS.ProcessEnv = process.env): ClickHouseTarget {
  const host = env.CLICKHOUSE_HOST || "localhost";
  const port = env.CLICKHOUSE_PORT || "8123";
  return {
    url: env.CLICKHOUSE_URL || `http://${host}:${port}`,
    user: env.CLICKHOUSE_USER || "default",
    password: env.CLICKHOUSE_PASSWORD || "",
    database: env.CLICKHOUSE_DATABASE || "default",
  };
}

const BATCH = 5000;

async function run(target: ClickHouseTarget, statement: string, body = ""): Promise<string> {
  const params = new URLSearchParams({
    database: target.database,
    query: statement,
    output_format_json_quote_decimals: "1",
    output_format_json_quote_64bit_integers: "0",
  });
  const response = await fetch(`${target.url.replace(/\/+$/, "")}/?${params}`, {
    method: "POST",
    headers: { "X-ClickHouse-User": target.user, "X-ClickHouse-Key": target.password },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `ClickHouse rejected the statement (${response.status}): ${text.trim().slice(0, 300)}`,
    );
  }
  return text;
}

async function insert(target: ClickHouseTarget, table: string, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    const body = rows
      .slice(i, i + BATCH)
      .map((row) => JSON.stringify(row))
      .join("\n");
    await run(target, `INSERT INTO ${table} FORMAT JSONEachRow`, body);
  }
}

export const insertTraces = (t: ClickHouseTarget, rows: TraceRow[]) => insert(t, "traces", rows);
export const insertSpans = (t: ClickHouseTarget, rows: SpanRow[]) => insert(t, "spans", rows);

const quoteList = (ids: string[]) => ids.map((id) => `'${id.replace(/['\\]/g, "")}'`).join(",");

/** Remove every row of the given projects, and wait for the deletion to finish. */
export async function deleteProjectRows(t: ClickHouseTarget, projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;
  for (const table of ["traces", "spans"]) {
    await run(
      t,
      `ALTER TABLE ${table} DELETE WHERE project_id IN (${quoteList(projectIds)}) SETTINGS mutations_sync = 2`,
    );
  }
}

export async function countProjectRows(
  t: ClickHouseTarget,
  projectIds: string[],
): Promise<{ traces: number; spans: number }> {
  if (projectIds.length === 0) return { traces: 0, spans: 0 };
  const count = async (table: string) =>
    Number(
      (
        await run(t, `SELECT count() FROM ${table} WHERE project_id IN (${quoteList(projectIds)})`)
      ).trim(),
    );
  return { traces: await count("traces"), spans: await count("spans") };
}

/** For checks against the manifest: run any read-only query and return the text. */
export const queryText = (t: ClickHouseTarget, sql: string) => run(t, sql);
