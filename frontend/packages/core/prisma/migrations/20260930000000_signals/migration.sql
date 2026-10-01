-- Signals (ee/signals): group detector hits into one row per recurring problem.
-- Bound lock acquisition. The only existing table touched is detectors, and both
-- columns added to it take defaults Postgres evaluates once and keeps in the
-- catalog, so the table is not rewritten. Roll back atomically on timeout;
-- resolve the failed migration and retry during a quiet window.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Per-detector switch, on for existing and new detectors. RCA follows signals, so
-- a detector with the switch off (or a deployment without the embedding and
-- assignment keys, which the worker treats as off) runs no grouping and no RCA;
-- its findings still reach the per-finding digest.
-- signals_enabled_at bounds grouping to hits detected after the switch was turned
-- on, so upgrading does not group history. CURRENT_TIMESTAMP is evaluated once for
-- the existing rows, without rewriting the table.
ALTER TABLE "detectors"
  ADD COLUMN "enable_signals" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "signals_enabled_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "signals" (
  "id"                  VARCHAR NOT NULL,
  "project_id"          VARCHAR NOT NULL,
  "detector_id"         VARCHAR NOT NULL,
  "title"               VARCHAR NOT NULL,
  "criteria_covers"     TEXT NOT NULL,
  "criteria_excludes"   TEXT NOT NULL,
  "criteria_version"    INTEGER NOT NULL DEFAULT 1,
  "anchor_text"         TEXT NOT NULL,
  "anchor_embedding"    REAL[],
  "group_key"           VARCHAR,
  "status"              VARCHAR NOT NULL DEFAULT 'open',
  "resolved_at"         TIMESTAMP(6),
  "reopen_seq"          INTEGER NOT NULL DEFAULT 0,
  "hit_count"           INTEGER NOT NULL DEFAULT 0,
  "first_seen_at"       TIMESTAMP(6) NOT NULL,
  "last_seen_at"        TIMESTAMP(6) NOT NULL,
  "notified_reopen_seq" INTEGER,
  "notified_hit_count"  INTEGER NOT NULL DEFAULT 0,
  "notified_at"         TIMESTAMP(6),
  "merged_into_id"      VARCHAR,
  "create_time"         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "update_time"         TIMESTAMP(6) NOT NULL,
  CONSTRAINT "signals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signals_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "signals_merged_into_id_fkey" FOREIGN KEY ("merged_into_id") REFERENCES "signals"("id") ON DELETE SET NULL ON UPDATE NO ACTION
);
CREATE INDEX "ix_signal_project_detector" ON "signals"("project_id", "detector_id");
-- One signal per fixed grouping key (Jev-path hits group by category). Partial,
-- so it cannot be expressed in schema.prisma.
CREATE UNIQUE INDEX "uq_signal_group_key" ON "signals"("project_id", "detector_id", "group_key") WHERE "group_key" IS NOT NULL;

CREATE TABLE "signal_hits" (
  "run_id"           VARCHAR NOT NULL,
  "signal_id"        VARCHAR NOT NULL,
  "project_id"       VARCHAR NOT NULL,
  "detector_id"      VARCHAR NOT NULL,
  "trace_id"         VARCHAR NOT NULL,
  "finding_id"       VARCHAR NOT NULL,
  "seen_at"          TIMESTAMP(6) NOT NULL,
  "score"            DOUBLE PRECISION,
  "criteria_version" INTEGER,
  "assigned_at"      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "signal_hits_pkey" PRIMARY KEY ("run_id"),
  CONSTRAINT "signal_hits_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "ix_signal_hit_signal_seen" ON "signal_hits"("signal_id", "seen_at");
CREATE INDEX "ix_signal_hit_finding" ON "signal_hits"("finding_id");
CREATE INDEX "ix_signal_hit_project_trace" ON "signal_hits"("project_id", "trace_id");

ALTER TABLE "signal_hits"
  ADD COLUMN "embedding" DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
  ADD COLUMN "copy_pending" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "reported_at" TIMESTAMP(6);
CREATE INDEX "ix_signal_hit_pending_copy"
  ON "signal_hits"("project_id", "detector_id", "assigned_at") WHERE "copy_pending";
CREATE INDEX "ix_signal_hit_unreported" ON "signal_hits"("signal_id") WHERE "reported_at" IS NULL;

CREATE TABLE "signal_rcas" (
  "signal_id"   VARCHAR NOT NULL,
  "reopen_seq"  INTEGER NOT NULL,
  "finding_id"  VARCHAR NOT NULL,
  "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "signal_rcas_pkey" PRIMARY KEY ("signal_id", "reopen_seq"),
  CONSTRAINT "signal_rcas_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "signal_rcas_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "detector_rcas"("finding_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "ix_signal_rca_finding" ON "signal_rcas"("finding_id");

CREATE TABLE "signal_status_events" (
  "id"            VARCHAR NOT NULL,
  "signal_id"     VARCHAR NOT NULL,
  "actor_user_id" VARCHAR NOT NULL,
  "from_status"   VARCHAR NOT NULL,
  "to_status"     VARCHAR NOT NULL,
  "reason"        VARCHAR,
  "note"          TEXT,
  "create_time"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "signal_status_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "signal_status_events_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "signals"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "ix_signal_status_event_signal_time" ON "signal_status_events"("signal_id", "create_time");

-- No backfill: hits from before a detector's signals were on stay unassigned,
-- and every reader treats a finding with no signal_hits row as ungrouped.
COMMIT;
