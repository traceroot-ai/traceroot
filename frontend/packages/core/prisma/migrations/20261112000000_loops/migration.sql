-- Loop: a per-project scheduled agent, its runs and its memory. M1 ships the
-- tables and the Loops screens on seeded data; no worker reads them yet.
--
-- Additive only: three new tables, one enum value, one nullable column and one
-- defaulted flag. `loops.detector_id` is the Loop's hidden detector (RESTRICT:
-- the write path deletes the Loop first, then the detector).
-- AlterEnum
ALTER TYPE "TurnKind" ADD VALUE 'loop_execution';

-- AlterTable
ALTER TABLE "ai_sessions" ADD COLUMN     "loop_run_id" VARCHAR;

-- AlterTable
ALTER TABLE "workspaces" ADD COLUMN     "loop_blocked" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "loops" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "detector_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "template" VARCHAR,
    "instructions" TEXT NOT NULL DEFAULT '',
    "template_version" INTEGER,
    "schedule_kind" VARCHAR NOT NULL,
    "interval_hours" INTEGER,
    "weekday" INTEGER,
    "hour" INTEGER,
    "timezone" VARCHAR,
    "status" VARCHAR NOT NULL DEFAULT 'active',
    "pause_reason" VARCHAR,
    "status_changed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status_changed_by" VARCHAR,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "precheck_sql" TEXT,
    "last_precheck_at" TIMESTAMP(6),
    "last_precheck_outcome" VARCHAR,
    "model" VARCHAR,
    "provider" VARCHAR,
    "source" VARCHAR,
    "max_findings_per_run" INTEGER NOT NULL DEFAULT 2,
    "lookback_hours" INTEGER NOT NULL DEFAULT 24,
    "next_run_at" TIMESTAMP(6),
    "last_run_at" TIMESTAMP(6),
    "failure_streak" INTEGER NOT NULL DEFAULT 0,
    "created_by" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "loops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loop_runs" (
    "id" VARCHAR NOT NULL,
    "loop_id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "seq" INTEGER NOT NULL,
    "trigger" VARCHAR NOT NULL,
    "slot_at" TIMESTAMP(6),
    "status" VARCHAR NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "session_id" VARCHAR,
    "started_at" TIMESTAMP(6),
    "finished_at" TIMESTAMP(6),
    "summary" TEXT,
    "finding_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "traces_read" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metadata" JSONB,
    "cost_usd" DECIMAL(10,6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "loop_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "loop_memories" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "loop_id" VARCHAR,
    "key" VARCHAR(200) NOT NULL,
    "content" TEXT NOT NULL,
    "expires_at" TIMESTAMP(6),
    "updated_by_run_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "loop_memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_loop_detector" ON "loops"("detector_id");

-- CreateIndex
CREATE INDEX "ix_loop_project_id" ON "loops"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loop_project_name" ON "loops"("project_id", "name");

-- CreateIndex
CREATE INDEX "ix_loop_run_project_time" ON "loop_runs"("project_id", "create_time");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loop_run_loop_seq" ON "loop_runs"("loop_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loop_run_loop_slot" ON "loop_runs"("loop_id", "slot_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_loop_memory_project_key" ON "loop_memories"("project_id", "key");

-- CreateIndex
CREATE INDEX "ix_ai_session_loop_run_id" ON "ai_sessions"("loop_run_id");

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_detector_id_fkey" FOREIGN KEY ("detector_id") REFERENCES "detectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_runs" ADD CONSTRAINT "loop_runs_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_runs" ADD CONSTRAINT "loop_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_runs" ADD CONSTRAINT "loop_runs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_memories" ADD CONSTRAINT "loop_memories_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loop_memories" ADD CONSTRAINT "loop_memories_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The scheduler's claim query reads only active Loops, ordered by due time.
-- Prisma cannot express a partial index, so it is raw SQL here.
CREATE INDEX "ix_loop_next_run" ON "loops"("next_run_at") WHERE "status" = 'active';
