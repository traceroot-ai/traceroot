-- New detectors default to 25% sampling so the out-of-the-box cost profile
-- stays light. Existing rows keep their configured sample_rate; only the
-- column default changes.
ALTER TABLE "detectors" ALTER COLUMN "sample_rate" SET DEFAULT 25;
