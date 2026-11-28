// One-time import of the cloud service's existing users into the newsletter
// segment: everyone who signed up before NEWSLETTER_START_AT, less team and test
// accounts, AI agents and anyone who opted out of product email. People who
// sign up from then are added 14 days on by the scheduled tick.
//
// A dry run unless --apply is given: it writes nothing, to the database or the
// provider, and prints the counts the import would produce. With --apply it
// adds each person and stamps them as it goes, so it can be stopped and run
// again: it continues with whoever is left, and a person it could not reach is
// tried again on the next run. Prints counts only, never addresses.
//
// Run from frontend/packages/core with the web service's settings:
//   DATABASE_URL, RESEND_API_KEY, RESEND_PRODUCT_TOPIC_ID,
//   RESEND_NEWSLETTER_SEGMENT_ID, NEWSLETTER_START_AT,
//   TEAM_EMAIL_DOMAINS (default traceroot.ai), SKIP_EMAILS
//
//   node --experimental-strip-types scripts/newsletter-import.ts           # dry run
//   node --experimental-strip-types scripts/newsletter-import.ts --apply   # import
import { PrismaClient } from "@prisma/client";
import { runNewsletterAudience } from "../src/lib/email/newsletter.ts";

const apply = process.argv.includes("--apply");
const prisma = new PrismaClient();

try {
  const run = await runNewsletterAudience(prisma, {
    mode: { kind: "import" },
    apply,
    log: () => {},
  });
  if (run.notRun) {
    console.error(`newsletter-import: nothing done (${run.notRun})`);
    process.exitCode = 1;
  } else {
    const verb = apply ? "added" : "would add";
    console.log(
      `newsletter-import (${apply ? "applied" : "dry run, nothing written"}): ` +
        `looked at ${run.considered} not yet on the segment; ${verb} ${run.added} ` +
        `(${run.withoutContact} without a contact yet); left out ${JSON.stringify(run.excluded)}; ` +
        `could not reach the provider for ${run.failed}${run.failed ? ", run again to retry them" : ""}`,
    );
    if (run.failed) process.exitCode = 2;
  }
} catch (error) {
  console.error(`newsletter-import: failed (${error instanceof Error ? error.name : "error"})`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
