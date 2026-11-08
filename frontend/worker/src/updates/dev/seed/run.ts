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
import { DEAD_REPO, OVERSIZE_REPO, SEEDED_REPO, SLOW_REPO, UNREACHABLE_REPO_URL } from "./plan.js";
import {
  cleanPostgres,
  countPostgres,
  writePostgres,
  type PostgresOptions,
} from "./postgres-io.js";
import { buildScenario, projectIdOf, scheduleOf, type SeedParams } from "./scenario.js";
import { prisma } from "@traceroot/core";
import { createUpdateRunQueue } from "../../queue.js";

export const DEFAULT_OUT_DIR = path.join(os.tmpdir(), "traceroot-update-seed");
export const DEFAULT_BIG_BYTES = 30 * 1024 * 1024;
export const DEFAULT_SLOW_PORT = 18581;
/** Where the seeded repositories are served without delay. */
export const DEFAULT_GIT_PORT = 18580;
/**
 * A blobless, shallow-since, no-checkout clone makes three requests, each held
 * back by this long, so the default clone takes ~210 s: past the 180 s clone ceiling.
 */
export const DEFAULT_SLOW_DELAY_MS = 70_000;
export const SLOW_CLONE_REQUESTS = 3;

export interface SeedOptions {
  params: SeedParams;
  outDir?: string;
  bigBytes?: number;
  slowPort?: number;
  gitPort?: number;
  slowDelayMs?: number;
  postgres?: PostgresOptions;
}

const PROJECT_KEYS = [
  "main",
  "nogit",
  "tiny",
  "empty",
  "other",
  "cloneslow",
  "clonebig",
  "clonedead",
] as const;
const projectIds = (prefix: string) => PROJECT_KEYS.map((k) => projectIdOf(prefix, k));

/** Remove only what this prefix created: its rows, workspaces and output directory. */
/** Hosts the seeder will touch. Anything else needs an explicit opt-in. */
const LOCAL_HOSTS =
  /^(localhost|127\.0\.0\.1|\[?::1\]?|postgres|clickhouse|host\.docker\.internal)$/;

export function assertLocalStack(env: NodeJS.ProcessEnv = process.env): void {
  if (env.TRACEROOT_UPDATES_SEED_ALLOW_REMOTE === "1") return;
  const hosts = [
    env.CLICKHOUSE_URL ? new URL(env.CLICKHOUSE_URL).hostname : env.CLICKHOUSE_HOST || "localhost",
    env.DATABASE_URL ? new URL(env.DATABASE_URL).hostname : "localhost",
  ];
  const remote = hosts.filter((h) => !LOCAL_HOSTS.test(h));
  if (remote.length > 0) {
    throw new Error(
      `Refusing to seed or clean a stack at ${remote.join(", ")}. The seeder deletes data by prefix; ` +
        "set TRACEROOT_UPDATES_SEED_ALLOW_REMOTE=1 only for a throwaway stack.",
    );
  }
}

export async function cleanSeed(params: SeedParams, outDir = DEFAULT_OUT_DIR): Promise<void> {
  assertLocalStack();
  await deleteProjectRows(clickHouseTargetFromEnv(), projectIds(params.prefix));
  await cleanPostgres(params.prefix);
  await clearRunQueue(params.prefix);
  // Only the entries this script writes, never the directory itself: --out may
  // point at a directory that holds other things.
  for (const entry of OUTPUT_ENTRIES) {
    await fs.rm(path.join(outDir, entry), { recursive: true, force: true });
  }
  await fs.rmdir(outDir).catch(() => undefined);
}

/**
 * Queued and finished run jobs are keyed by project and slot, so a re-seeded
 * project would find its old job and never run. Only this prefix's jobs go.
 */
async function clearRunQueue(prefix: string): Promise<void> {
  const { queue, close } = createUpdateRunQueue();
  try {
    const jobs = await queue.getJobs(["waiting", "delayed", "completed", "failed", "paused"]);
    for (const job of jobs) {
      if (job.data.projectId.startsWith(`${prefix}-`)) await job.remove().catch(() => undefined);
    }
  } finally {
    await close();
  }
}

const OUTPUT_ENTRIES = [
  "manifest.json",
  "github-fixtures.json",
  "seed-org",
  "seed-app-work",
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
  // The payload lands when the planted bad release merges, inside the current window.
  const payloadAt = plannedCommits.find((c) => c.key === "bad")!.at;
  const big = await buildOversizeRepo(outDir, bigBytes, payloadAt, plannedCommits[0].at);

  const scenario = buildScenario(params, seeded.shas, {
    big: { base: big.baseSha, payload: big.payloadSha },
  });
  const target = clickHouseTargetFromEnv();
  for (const project of scenario.projects) {
    await insertTraces(target, project.data.traces);
    await insertSpans(target, project.data.spans);
  }
  await writePostgres(scenario, options.postgres);

  const repos: RepoCases = {
    seeded: { repo: SEEDED_REPO, path: "seed-org/seed-app.git" },
    oversize: { repo: OVERSIZE_REPO, path: "seed-org/seed-big.git", bytes: big.bytes },
    slow: {
      repo: SLOW_REPO,
      path: "seed-org/seed-app.git",
      url: `http://127.0.0.1:${slowPort}/seed-org/seed-app.git`,
      delayMs: slowDelayMs,
      approxCloneMs: slowDelayMs * SLOW_CLONE_REQUESTS,
      port: slowPort,
    },
    unreachable: { repo: DEAD_REPO, url: UNREACHABLE_REPO_URL },
  };
  const manifest = buildManifest(scenario, repos);
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await fs.writeFile(
    path.join(outDir, "github-fixtures.json"),
    JSON.stringify(
      buildGithubFixtures(scenario.commits, seeded.shas, {
        gitBase: `http://127.0.0.1:${options.gitPort ?? DEFAULT_GIT_PORT}`,
        slowBase: `http://127.0.0.1:${slowPort}`,
        deadUrl: UNREACHABLE_REPO_URL,
        big: { baseSha: big.baseSha, payloadSha: big.payloadSha, payloadAt, bytes: big.bytes },
      }),
      null,
      2,
    ) + "\n",
  );
  return { manifest, outDir, scenario };
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
