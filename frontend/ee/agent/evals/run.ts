/**
 * Live entry point for the agent write-tool evals.
 *
 * Drives the real agent service with a real model against the running dev
 * stack, then scores what the write tools actually persisted. Wiring only —
 * every decision it makes lives in a unit-tested module beside it.
 *
 *   pnpm --filter @traceroot/agent evals
 *
 * Requires the dev stack to be up; this never starts or stops anything.
 * Env: AGENT_SERVICE_URL, TRACE_API_URL (or NEXT_PUBLIC_API_URL),
 * EVAL_USER_EMAIL, EVAL_MODEL, EVAL_TIMEOUT_MS, and --keep to retain the
 * fixture project for inspection.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "@traceroot/core";
import { probeWidgetQuery } from "./assertions.js";
import { AgentClient, StackNotRunningError } from "./client.js";
import { runAll } from "./runner.js";
import { SCENARIOS } from "./scenarios.js";
import { allPassed, formatScorecard } from "./scorecard.js";
import { createEvalProject, resolveEvalUser, teardownEvalProject } from "./setup.js";
import { makeCanonicalPrompt } from "./template-catalog.js";
import type { EvalPrisma, ScenarioResult } from "./types.js";

const AGENT_SERVICE_URL = process.env.AGENT_SERVICE_URL || "http://localhost:8100";
const TRACE_API_URL =
  process.env.TRACE_API_URL || process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
const EVAL_USER_EMAIL = process.env.EVAL_USER_EMAIL || "axd2025@nyu.edu";
const RESULTS_ROOT = fileURLToPath(new URL(".results", import.meta.url));

// The generated client's delegates are far more specific than the harness
// needs; the structural view is what keeps the helpers unit-testable.
const db = prisma as unknown as EvalPrisma;

function parseTimeout(): number | undefined {
  const raw = process.env.EVAL_TIMEOUT_MS;
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<number> {
  const keepFixture = process.argv.includes("--keep");
  const runId = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;

  const user = await resolveEvalUser(db, EVAL_USER_EMAIL);
  const client = new AgentClient({
    baseUrl: AGENT_SERVICE_URL,
    userId: user.id,
    workspaceId: user.workspaceId,
    model: process.env.EVAL_MODEL,
    timeoutMs: parseTimeout(),
  });

  // Preflight before anything is written, so a stopped stack leaves no trace.
  await client.checkHealth();

  const fixture = await createEvalProject(db, { user, runId });
  const resultsDir = join(RESULTS_ROOT, runId);
  mkdirSync(resultsDir, { recursive: true });

  console.log(`run ${runId}  user ${user.email}  project ${fixture.projectName}`);
  console.log(`agent ${AGENT_SERVICE_URL}  backend ${TRACE_API_URL}\n`);

  let results: ScenarioResult[] = [];
  try {
    results = await runAll(SCENARIOS, {
      client,
      prisma: db,
      fixture,
      canonicalPrompt: makeCanonicalPrompt(),
      probeWidgetQuery: (spec) =>
        probeWidgetQuery(spec, {
          baseUrl: TRACE_API_URL,
          projectId: fixture.projectId,
          userId: user.id,
          userEmail: user.email,
        }),
      onResult: (result) => {
        writeFileSync(
          join(resultsDir, `${result.name}.json`),
          `${JSON.stringify(result, null, 2)}\n`,
        );
        console.log(
          `${result.passed ? "PASS" : "FAIL"}  ${result.name}${result.error ? `  ${result.error}` : ""}`,
        );
      },
    });
  } finally {
    if (keepFixture) {
      console.log(`\nkeeping fixture project ${fixture.projectId} (--keep)`);
    } else {
      await teardownEvalProject(db, fixture.projectId);
    }
  }

  console.log(`\n${formatScorecard(results)}`);
  console.log(`transcripts: ${resultsDir}`);
  return allPassed(results) ? 0 : 1;
}

main()
  .then(async (code) => {
    await prisma.$disconnect();
    process.exit(code);
  })
  .catch(async (error) => {
    if (error instanceof StackNotRunningError) {
      console.error(`stack not running: ${error.message}`);
    } else {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
    }
    await prisma.$disconnect();
    process.exit(2);
  });
