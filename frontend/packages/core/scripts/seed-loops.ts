/**
 * Seed (or clean) the Loops screens in a dev or test project.
 *
 *   pnpm --filter @traceroot/core loops:seed --project <id> [--clean] [--free-cap] [--complete-pending]
 *
 * Refuses outside development and test. Every run first removes what an
 * earlier run created, so seed -> seed and seed -> clean -> seed end in the
 * same state.
 */
import { prisma } from "../src/lib/prisma.ts";
import { cleanLoops, countLoops, seedLoops, SEED_ACTOR } from "../src/loops/dev/seed.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (process.argv[i + 1] ?? "");
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const env = process.env.NODE_ENV;
  if (env !== undefined && env !== "development" && env !== "test") {
    throw new Error(`Refusing to seed Loops with NODE_ENV=${env}: development and test only.`);
  }
  const projectId = arg("project");
  if (!projectId)
    throw new Error("Usage: loops:seed --project <id> [--clean] [--free-cap] [--complete-pending]");

  if (flag("clean")) {
    await cleanLoops(prisma, projectId);
    console.log(
      JSON.stringify({
        action: "clean",
        actor: SEED_ACTOR,
        counts: await countLoops(prisma, projectId),
      }),
    );
    return;
  }
  const counts = await seedLoops(prisma, projectId, {
    freeCap: flag("free-cap"),
    completePending: flag("complete-pending"),
  });
  console.log(JSON.stringify({ action: "seed", counts }));
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
