/**
 * One-off replay to the sign-up webhook, run by hand, for the backfill of
 * existing users. Dry run by default: it counts what it would send.
 *
 *   node worker/dist/signups/replay-cli.js --delivery backfill
 *   node worker/dist/signups/replay-cli.js --delivery backfill --send
 *
 * --from and --to bound the sign-up window (ISO dates). The default window is
 * everything up to an hour ago.
 */
import { parseArgs } from "node:util";
import { prisma } from "@traceroot/core";
import { isSignupWebhookConfigured } from "@traceroot/core/signup-webhook";
import { replaySignups, signupWebhookConfigFromEnv } from "./replay.js";

function parseDate(value: string | undefined, fallback: Date, flag: string): Date {
  if (value === undefined) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${flag} is not a date: ${value}`);
  return date;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      delivery: { type: "string", default: "backfill" },
      from: { type: "string" },
      to: { type: "string" },
      send: { type: "boolean", default: false },
    },
  });
  const delivery = values.delivery;
  if (delivery !== "backfill" && delivery !== "reconcile") {
    throw new Error(`--delivery must be backfill or reconcile, not ${delivery}`);
  }
  const from = parseDate(values.from, new Date(0), "--from");
  const to = parseDate(values.to, new Date(Date.now() - 60 * 60 * 1000), "--to");
  const config = signupWebhookConfigFromEnv();
  if (values.send && !isSignupWebhookConfigured(config)) {
    throw new Error(
      "--send needs TRACEROOT_SIGNUP_WEBHOOK_URL and TRACEROOT_SIGNUP_WEBHOOK_SECRET",
    );
  }

  const result = await replaySignups({ delivery, from, to, config, send: values.send });
  const mode = values.send ? "Sent" : "Dry run, nothing sent";
  console.log(
    `[Signup replay] ${mode}: ${result.eligible} sign-ups (${delivery}) from ${from.toISOString()} to ${to.toISOString()}`,
  );
  console.log(
    `[Signup replay] By sign-up method: ${JSON.stringify(result.byProvider)}; invited: ${result.invited}`,
  );
  if (values.send) console.log(`[Signup replay] Delivered ${result.sent}, failed ${result.failed}`);
  else console.log("[Signup replay] Pass --send to deliver them.");
}

main()
  .catch((error: unknown) => {
    console.error("[Signup replay] Failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
