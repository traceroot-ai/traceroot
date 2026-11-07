/**
 * Replays to the sign-up webhook, run by hand. Dry run by default: it counts
 * what it would send.
 *
 *   node worker/dist/signups/replay-cli.js --list-unrecorded > ids.txt
 *   node worker/dist/signups/replay-cli.js --backfill ids.txt [--send]
 *   node worker/dist/signups/replay-cli.js --reconcile [--send]
 *
 * --list-unrecorded prints the ID and creation time of every account created
 * before the sign-up method was recorded, for review: how those accounts were
 * created is unknown, so only an approved list of them is ever sent.
 * --backfill sends the user IDs in a file, one per line (blank lines and
 * #-comments ignored). Accounts recorded as provisioned by staff are left out,
 * and acknowledged ones aren't sent again, so an interrupted backfill can be
 * rerun with the same file and is reported as the same run.
 * --reconcile runs the weekly replay now.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { prisma } from "@traceroot/core";
import { isSignupWebhookConfigured } from "@traceroot/core/signup-webhook";
import {
  backfillSignups,
  countUnrecordedAccounts,
  parseUserIds,
  reconcileSignups,
  signupWebhookConfigFromEnv,
  type ReplayResult,
} from "./replay.js";

async function listUnrecorded(): Promise<void> {
  let after = "";
  for (;;) {
    const users = await prisma.user.findMany({
      where: { signupMethod: null, id: { gt: after } },
      orderBy: { id: "asc" },
      take: 500,
      select: { id: true, createdAt: true },
    });
    for (const user of users) console.log(`${user.id}  # created ${user.createdAt.toISOString()}`);
    if (users.length < 500) return;
    after = users[users.length - 1]!.id;
  }
}

function report(result: ReplayResult, send: boolean): void {
  const mode = send ? "Sent" : "Dry run, nothing sent";
  console.log(`[Signup replay] ${mode}: run ${result.runId}, ${result.eligible} sign-ups`);
  console.log(`[Signup replay] By sign-up method: ${JSON.stringify(result.byProvider)}`);
  if (result.alreadyDelivered > 0) {
    console.log(`[Signup replay] ${result.alreadyDelivered} already acknowledged, not sent again`);
  }
  if (result.excluded > 0 || result.notFound > 0) {
    console.log(
      `[Signup replay] Left out: ${result.excluded} provisioned by staff, ${result.notFound} not found`,
    );
  }
  if (send) {
    const summary = result.summarySent ? "summary delivered" : "summary NOT delivered";
    console.log(`[Signup replay] Delivered ${result.sent}, failed ${result.failed}, ${summary}`);
    if (result.failed > 0 || !result.summarySent) process.exitCode = 1;
  } else {
    console.log("[Signup replay] Pass --send to deliver them.");
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "list-unrecorded": { type: "boolean", default: false },
      backfill: { type: "string" },
      reconcile: { type: "boolean", default: false },
      send: { type: "boolean", default: false },
    },
  });
  const modes = [values["list-unrecorded"], values.backfill !== undefined, values.reconcile];
  if (modes.filter(Boolean).length !== 1) {
    throw new Error("Pass one of --list-unrecorded, --backfill <file> or --reconcile");
  }
  if (values["list-unrecorded"]) return listUnrecorded();

  const config = signupWebhookConfigFromEnv();
  if (values.send && !isSignupWebhookConfigured(config)) {
    throw new Error(
      "--send needs TRACEROOT_SIGNUP_WEBHOOK_URL and TRACEROOT_SIGNUP_WEBHOOK_SECRET",
    );
  }
  const send = values.send;
  if (values.backfill !== undefined) {
    const userIds = parseUserIds(await readFile(values.backfill, "utf8"));
    if (userIds.length === 0) throw new Error(`${values.backfill} lists no user IDs`);
    report(await backfillSignups({ userIds, config, send }), send);
    return;
  }
  report(await reconcileSignups({ config, send }), send);
  const unrecorded = await countUnrecordedAccounts();
  if (unrecorded > 0) {
    console.log(
      `[Signup replay] ${unrecorded} accounts have no recorded sign-up method and are only sent from an approved --backfill list`,
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error("[Signup replay] Failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
