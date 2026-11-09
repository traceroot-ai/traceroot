/**
 * Seed, inspect or remove the deterministic update fixtures.
 *
 *   pnpm --filter traceroot-worker update:seed seed  [options]
 *   pnpm --filter traceroot-worker update:seed clean [--prefix seedupd]
 *   pnpm --filter traceroot-worker update:seed counts
 *   pnpm --filter traceroot-worker update:seed verify  [--out dir]   (ClickHouse vs the manifest)
 *   pnpm --filter traceroot-worker update:seed check-facts [--out dir] (computed facts vs the planted changes; needs the backend)
 *   pnpm --filter traceroot-worker update:seed serve-slow [--port 18581] [--delay-ms 70000]
 *   pnpm --filter traceroot-worker update:seed serve-git [--port 18580]      (seeded repositories, no delay)
 *   pnpm --filter traceroot-worker update:seed serve-github [--port 18582]   (the GitHub API stand-in)
 *
 * See README.md next to this file.
 */
import { parseArgs } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { clickHouseTargetFromEnv } from "./clickhouse-io.js";
import { verifyManifest, verifyPostgres } from "./verify.js";
import { computeUpdateFacts } from "@traceroot/core/updates";
import { aggregatesConfigFromEnv, readRunAggregates } from "../../aggregates-client.js";
import { checkAggregates, checkFacts } from "./check-facts.js";
import { checkDigest } from "./check-digest.js";
import { prisma } from "@traceroot/core";
import type { UpdateResult } from "@traceroot/core/updates";
import { startSlowRemote } from "./slow-remote.js";
import { startGithubStub } from "../github-stub.js";
import {
  DEFAULT_BIG_BYTES,
  DEFAULT_GIT_PORT,
  DEFAULT_OUT_DIR,
  DEFAULT_SLOW_DELAY_MS,
  DEFAULT_SLOW_PORT,
  cleanSeed,
  countSeed,
  disconnect,
  runSeed,
} from "./run.js";
import { connectSlack } from "./postgres-io.js";
import { defaultParams, workspaceIdOf } from "./scenario.js";

const options = {
  seed: { type: "string" },
  now: { type: "string" },
  frequency: { type: "string" },
  weekday: { type: "string" },
  hour: { type: "string" },
  timezone: { type: "string" },
  volume: { type: "string" },
  prefix: { type: "string" },
  out: { type: "string" },
  "big-bytes": { type: "string" },
  port: { type: "string" },
  "delay-ms": { type: "string" },
  slack: { type: "boolean" },
  "member-email": { type: "string" },
} as const;

function paramsFrom(values: Record<string, string | boolean | undefined>) {
  const num = (v: unknown) => (typeof v === "string" ? Number(v) : undefined);
  const frequency = values.frequency as "daily" | "weekly" | undefined;
  if (frequency !== undefined && frequency !== "daily" && frequency !== "weekly") {
    throw new Error("--frequency must be daily or weekly.");
  }
  return defaultParams({
    ...(typeof values.seed === "string" ? { seed: values.seed } : {}),
    ...(typeof values.now === "string" ? { now: new Date(values.now) } : {}),
    ...(frequency ? { frequency } : {}),
    ...(typeof values.weekday === "string" ? { weekday: num(values.weekday)! } : {}),
    ...(typeof values.hour === "string" ? { hour: num(values.hour)! } : {}),
    ...(typeof values.timezone === "string" ? { timezone: values.timezone } : {}),
    ...(typeof values.volume === "string" ? { volume: num(values.volume)! } : {}),
    ...(typeof values.prefix === "string" ? { prefix: values.prefix } : {}),
  });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ options, allowPositionals: true });
  const command = positionals[0] ?? "seed";
  const outDir = path.resolve(values.out ?? DEFAULT_OUT_DIR);

  if (command === "serve-git") {
    const remote = await startSlowRemote({
      root: outDir,
      delayMs: 0,
      port: Number(values.port ?? DEFAULT_GIT_PORT),
    });
    console.log(`seeded repositories served from ${outDir} at ${remote.url} (Ctrl+C to stop)`);
    await new Promise(() => {});
    return;
  }
  if (command === "serve-github") {
    const stub = await startGithubStub({
      fixturesPath: path.join(outDir, "github-fixtures.json"),
      port: Number(values.port ?? 18582),
    });
    console.log(`GitHub stand-in at ${stub.url} (Ctrl+C to stop)`);
    await new Promise(() => {});
    return;
  }
  if (command === "serve-slow") {
    const remote = await startSlowRemote({
      root: outDir,
      delayMs: Number(values["delay-ms"] ?? DEFAULT_SLOW_DELAY_MS),
      port: Number(values.port ?? DEFAULT_SLOW_PORT),
    });
    console.log(`slow remote serving ${outDir} at ${remote.url} (Ctrl+C to stop)`);
    await new Promise(() => {});
    return;
  }

  const params = paramsFrom(values);
  if (command === "clean") {
    await cleanSeed(params, outDir);
    console.log(JSON.stringify({ cleaned: params.prefix }, null, 2));
  } else if (command === "counts") {
    console.log(JSON.stringify(await countSeed(params), null, 2));
  } else if (command === "verify") {
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    const problems = [
      ...(await verifyManifest(clickHouseTargetFromEnv(), manifest)),
      ...(await verifyPostgres(manifest)),
    ];
    console.log(JSON.stringify({ ok: problems.length === 0, problems }, null, 2));
    if (problems.length > 0) process.exitCode = 1;
  } else if (command === "check-facts") {
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    const keys = Object.keys(manifest.projects);
    const report: Record<string, unknown> = {};
    let failed = false;
    for (const key of keys) {
      const windows = {
        windowStart: new Date(manifest.windows.current.start),
        windowEnd: new Date(manifest.windows.current.end),
        prevWindowStart: new Date(manifest.windows.previous.start),
        prevWindowEnd: new Date(manifest.windows.previous.end),
      };
      const { current, previous } = await readRunAggregates(
        aggregatesConfigFromEnv(),
        manifest.projects[key].id,
        windows,
      );
      const facts = computeUpdateFacts(current, previous);
      const problems = [
        ...checkAggregates(manifest, key, "current", current),
        ...checkAggregates(manifest, key, "previous", previous),
        ...checkFacts(manifest, key, facts),
      ];
      if (problems.length > 0) failed = true;
      report[key] = {
        findings: facts.findings.map((f) => f.id),
        nothingNotable: facts.nothingNotable,
        problems,
      };
    }
    console.log(JSON.stringify({ ok: !failed, report }, null, 2));
    if (failed) process.exitCode = 1;
  } else if (command === "check-digest") {
    const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
    const report: Record<string, unknown> = {};
    let failed = false;
    for (const key of Object.keys(manifest.projects)) {
      const run = await prisma.projectUpdateRun.findFirst({
        where: {
          projectId: manifest.projects[key].id,
          status: "succeeded",
          result: { not: undefined },
        },
        orderBy: { createTime: "desc" },
      });
      const result = run?.result as UpdateResult | null | undefined;
      if (!result) {
        report[key] = { run: null };
        continue;
      }
      const check = checkDigest(manifest, key, result);
      if (check.problems.length > 0 && !result.nothingToReport) failed = true;
      report[key] = { run: run!.id, nothingToReport: result.nothingToReport, ...check };
    }
    console.log(JSON.stringify({ ok: !failed, report }, null, 2));
    if (failed) process.exitCode = 1;
  } else if (command === "seed") {
    const slackToken = process.env.TRACEROOT_E2E_SLACK_BOT_TOKEN;
    const slackChannel = process.env.TRACEROOT_E2E_SLACK_TEST_CHANNEL_ID;
    if (values.slack && (!slackToken || !slackChannel)) {
      throw new Error(
        "--slack needs TRACEROOT_E2E_SLACK_BOT_TOKEN and TRACEROOT_E2E_SLACK_TEST_CHANNEL_ID.",
      );
    }
    const { manifest } = await runSeed({
      params,
      outDir,
      bigBytes: values["big-bytes"] ? Number(values["big-bytes"]) : DEFAULT_BIG_BYTES,
      slowPort: values.port ? Number(values.port) : undefined,
      slowDelayMs: values["delay-ms"] ? Number(values["delay-ms"]) : undefined,
      postgres: {
        inbox: process.env.TRACEROOT_E2E_TEST_INBOX,
        memberEmail: values["member-email"],
        slack: values.slack ? { botToken: slackToken!, channelId: slackChannel! } : undefined,
      },
    });
    console.log(
      JSON.stringify(
        {
          outDir,
          manifest: path.join(outDir, "manifest.json"),
          contentDigest: manifest.contentDigest,
        },
        null,
        2,
      ),
    );
  } else if (command === "connect-slack") {
    // Attach the dev Slack app to the already-seeded workspace, without re-seeding.
    const botToken = process.env.TRACEROOT_E2E_SLACK_BOT_TOKEN;
    const channelId = process.env.TRACEROOT_E2E_SLACK_TEST_CHANNEL_ID;
    if (!botToken || !channelId) {
      throw new Error(
        "connect-slack needs TRACEROOT_E2E_SLACK_BOT_TOKEN and TRACEROOT_E2E_SLACK_TEST_CHANNEL_ID.",
      );
    }
    await connectSlack(workspaceIdOf(params.prefix, "a"), { botToken, channelId });
    console.log(JSON.stringify({ connected: workspaceIdOf(params.prefix, "a"), channelId }));
  } else {
    throw new Error(
      `Unknown command "${command}". Use seed, clean, counts, verify, check-facts, check-digest, connect-slack, serve-slow, serve-git or serve-github.`,
    );
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(disconnect);
