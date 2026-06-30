-- Per-detector toggle for the agent-model root cause analysis.
-- Default true so existing detectors and new ones keep running RCA.
ALTER TABLE "detectors" ADD COLUMN "enable_rca" BOOLEAN NOT NULL DEFAULT true;
