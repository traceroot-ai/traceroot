-- Detector sample-rate default: 100 -> 25.
--
-- This change was previously captured, unnamed, in an earlier migration alongside
-- unrelated statements; it is pulled out here into its own named migration.
ALTER TABLE "detectors" ALTER COLUMN "sample_rate" SET DEFAULT 25;
