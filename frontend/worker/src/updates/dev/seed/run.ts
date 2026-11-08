import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsAt } from "@traceroot/core/updates";
import {
  clickHouseTargetFromEnv,
  countProjectRows,
  deleteProjectRows,
  insertSpans,
  insertTraces,
} from "./clickhouse-io.js";
import { buildGithubFixtures, buildOversizeRepo, buildSeededRepo, planCommits } from "./commits.js";
import { buildManifest, type RepoCases } from "./manifest.js";
import { OVERSIZE_REPO, SEEDED_REPO } from "./plan.js";
import {
  cleanPostgres,
  countPostgres,
  writePostgres,
  type PostgresOptions,
} from "./postgres-io.js";
import { buildScenario, projectIdOf, scheduleOf, type SeedParams } from "./scenario.js";
import { prisma } from "@traceroot/core";

export const DEFAULT_OUT_DIR = path.join(os.tmpdir(), "traceroot-update-seed");
export const DEFAULT_BIG_BYTES = 30 * 1024 * 1024;
export const DEFAULT_SLOW_PORT = 18581;
/**
 * A blobless shallow clone makes about five requests, each held back by this
 * long, so the default clone takes ~225 s: past the 180 s clone ceiling.
 */
export const DEFAULT_SLOW_DELAY_MS = 45_000;
export const SLOW_CLONE_REQUESTS = 5;

export interface SeedOptions {
  params: SeedParams;
  outDir?: string;
  bigBytes?: number;
  slowPort?: number;
  slowDelayMs?: number;
  postgres?: PostgresOptions;
}

const PROJECT_KEYS = ["main", "nogit", "tiny", "empty", "other"] as const;
const projectIds = (prefix: string) => PROJECT_KEYS.map((k) => projectIdOf(prefix, k));

/** Remove only what this prefix created: its rows, workspaces and output directory. */
export async function cleanSeed(params: SeedParams, outDir = DEFAULT_OUT_DIR): Promise<void> {
  await deleteProjectRows(clickHouseTargetFromEnv(), projectIds(params.prefix));
  await cleanPostgres(params.prefix);
  // Only the entries this script writes, never the directory itself: --out may
  // point at a directory that holds other things.
  for (const entry of OUTPUT_ENTRIES) {
    await fs.rm(path.join(outDir, entry), { recursive: true, force: true });
  }
  await fs.rmdir(outDir).catch(() => undefined);
}

const OUTPUT_ENTRIES = [
  "manifest.json",
  "github-fixtures.json",
  "seed-app.git",
  "seed-app-work",
  "seed-big.git",
  "seed-big-work",
];

export async function countSeed(params: SeedParams) {
  return {
    clickhouse: await countProjectRows(clickHouseTargetFromEnv(), projectIds(params.prefix)),
    postgres: await countPostgres(params.prefix),
  };
}

/**
 * Seed the stack: clean the prefix's own data, build the repositories, write
 * ClickHouse and Postgres, and leave the manifest and the GitHub fixtures in
 * the output directory. Safe to run again; it only ever removes its own data.
 */
export async function runSeed(options: SeedOptions) {
  const { params } = options;
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const bigBytes = options.bigBytes ?? DEFAULT_BIG_BYTES;
  const slowPort = options.slowPort ?? DEFAULT_SLOW_PORT;
  const slowDelayMs = options.slowDelayMs ?? DEFAULT_SLOW_DELAY_MS;

  await cleanSeed(params, outDir);
  await fs.mkdir(outDir, { recursive: true });

  const windows = windowsAt(scheduleOf(params), params.now);
  const plannedCommits = planCommits(windows);
  const seeded = await buildSeededRepo(outDir, plannedCommits);
  const big = await buildOversizeRepo(outDir, bigBytes, plannedCommits[0].at);

  const scenario = buildScenario(params, seeded.shas);
  const target = clickHouseTargetFromEnv();
  for (const project of scenario.projects) {
    await insertTraces(target, project.data.traces);
    await insertSpans(target, project.data.spans);
  }
  await writePostgres(scenario, options.postgres);

  const repos: RepoCases = {
    seeded: { repo: SEEDED_REPO, path: "seed-app.git" },
    oversize: { repo: OVERSIZE_REPO, path: "seed-big.git", bytes: big.bytes },
    slow: {
      repo: SEEDED_REPO,
      path: "seed-app.git",
      url: `http://127.0.0.1:${slowPort}/seed-app.git`,
      delayMs: slowDelayMs,
      approxCloneMs: slowDelayMs * SLOW_CLONE_REQUESTS,
      port: slowPort,
    },
    unreachable: { url: "http://127.0.0.1:9/seed-org/seed-unreachable.git" },
  };
  const manifest = buildManifest(scenario, repos);
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(
    path.join(outDir, "github-fixtures.json"),
    JSON.stringify(buildGithubFixtures(scenario.commits, seeded.shas), null, 2) + "\n",
  );
  return { manifest, outDir, scenario };
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
