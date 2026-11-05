-- The last successful RCA of each signal opening, kept apart from the shared
-- per-finding row, which a later attempt resets and may fail.
ALTER TABLE "signal_rcas"
  ADD COLUMN "result" TEXT,
  ADD COLUMN "root_cause" TEXT,
  ADD COLUMN "session_id" VARCHAR;
