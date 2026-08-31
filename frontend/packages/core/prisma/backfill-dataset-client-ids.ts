/**
 * One-off backfill: give every UI-authored dataset (client_dataset_id IS NULL) a
 * stable client id + key, derived the SAME way the SDK and the create route do
 * (canonical helper: frontend/ui/src/lib/eval/dataset-id.ts):
 *   ds_ = "ds_" + sha256(name)[:26]   and   key = name
 * so a UI-authored dataset converges with an SDK dataset of the same name.
 *
 * Idempotent: only touches rows with a null client id; if a row's derived id already
 * exists (a UI name that collides with an already-converged dataset) it is LEFT NULL
 * and logged rather than merged — that edge needs a human decision, not a silent join.
 *
 * Run from packages/core:
 *   npx dotenv -e ../../../.env -- npx tsx prisma/backfill-dataset-client-ids.ts
 */
import { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";

const prisma = new PrismaClient();

// Keep byte-identical to lib/eval/dataset-id.ts and the SDK (ids.py / ids.ts).
function stableDatasetId(key: string): string {
  return "ds_" + createHash("sha256").update(key, "utf8").digest("hex").slice(0, 26);
}

async function main() {
  const rows = await prisma.dataset.findMany({
    where: { clientDatasetId: null },
    select: { id: true, projectId: true, name: true },
  });
  console.log(`Found ${rows.length} UI dataset(s) without a client id.`);

  let updated = 0;
  let skipped = 0;
  for (const r of rows) {
    const clientDatasetId = stableDatasetId(r.name);
    try {
      await prisma.dataset.update({
        where: { id: r.id },
        data: { clientDatasetId, key: r.name },
      });
      updated++;
    } catch (e: unknown) {
      if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
        console.warn(
          `skip ${r.id} ("${r.name}", project ${r.projectId}): ${clientDatasetId} already exists`,
        );
        skipped++;
      } else {
        throw e;
      }
    }
  }
  console.log(`Backfilled ${updated}, skipped ${skipped}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
