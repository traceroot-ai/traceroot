-- AlterTable
ALTER TABLE "detectors" ALTER COLUMN "sample_rate" SET DEFAULT 25;

-- AlterTable
ALTER TABLE "human_scores" ALTER COLUMN "update_time" DROP DEFAULT;
