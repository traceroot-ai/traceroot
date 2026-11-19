-- Offline-eval schema (squashed).
--
-- Single final-schema migration replacing the 16 incremental eval migrations from the
-- unreleased offline-eval feature (add-then-drop churn — main_score, run provenance, index
-- swaps — collapsed away). Generated via prisma migrate diff, then the two partial indexes
-- Prisma cannot express in schema.prisma are appended as raw SQL.

-- CreateTable
CREATE TABLE "datasets" (
    "id" VARCHAR NOT NULL,
    "client_dataset_id" VARCHAR,
    "key" VARCHAR,
    "project_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "current_version_id" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_versions" (
    "id" VARCHAR NOT NULL,
    "dataset_id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "version_number" INTEGER NOT NULL,
    "label" VARCHAR NOT NULL,
    "note" TEXT,
    "created_by" VARCHAR,
    "idempotency_key" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_cases" (
    "id" VARCHAR NOT NULL,
    "test_case_id" VARCHAR NOT NULL,
    "dataset_version_id" VARCHAR NOT NULL,
    "dataset_id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "input" TEXT NOT NULL,
    "expected" TEXT,
    "metadata" JSONB,
    "review" VARCHAR NOT NULL DEFAULT 'needs_review',
    "capture_reason" VARCHAR NOT NULL DEFAULT 'manual',
    "source_trace_id" VARCHAR,
    "source_span_id" VARCHAR,
    "source_span_name" VARCHAR,
    "source_span_kind" VARCHAR,
    "source_run_id" VARCHAR,
    "source_result_id" VARCHAR,
    "added_by" VARCHAR,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluations" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "dataset_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "evaluation_key" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_runs" (
    "id" VARCHAR NOT NULL,
    "evaluation_id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "dataset_id" VARCHAR NOT NULL,
    "dataset_version_id" VARCHAR NOT NULL,
    "run_number" INTEGER NOT NULL,
    "candidate_version" VARCHAR NOT NULL,
    "environment" VARCHAR NOT NULL DEFAULT 'evaluation',
    "status" VARCHAR NOT NULL DEFAULT 'running',
    "baseline_run_id" VARCHAR,
    "case_count" INTEGER NOT NULL DEFAULT 0,
    "scored_count" INTEGER NOT NULL DEFAULT 0,
    "task_error_count" INTEGER NOT NULL DEFAULT 0,
    "scorer_error_count" INTEGER NOT NULL DEFAULT 0,
    "scorers" JSONB,
    "metadata" JSONB,
    "client_run_id" VARCHAR,
    "started_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "evaluation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evaluation_results" (
    "id" VARCHAR NOT NULL,
    "run_id" VARCHAR NOT NULL,
    "evaluation_id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "test_case_id" VARCHAR NOT NULL,
    "trace_id" VARCHAR,
    "input" TEXT NOT NULL,
    "expected_output" TEXT,
    "candidate_output" TEXT,
    "baseline_output" TEXT,
    "status" VARCHAR NOT NULL,
    "change" VARCHAR,
    "task_error" TEXT,
    "duration_ms" INTEGER,
    "cost" DOUBLE PRECISION,
    "cost_derived_at" TIMESTAMP(6),
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "evaluation_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scores" (
    "id" VARCHAR NOT NULL,
    "result_id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "scorer_name" VARCHAR NOT NULL,
    "scorer_version" VARCHAR NOT NULL,
    "numeric_value" DOUBLE PRECISION,
    "bool_value" BOOLEAN,
    "string_value" VARCHAR,
    "passed" BOOLEAN,
    "explanation" TEXT,
    "error" TEXT,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_dataset_project_id" ON "datasets"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dataset_project_client_id" ON "datasets"("project_id", "client_dataset_id");

-- CreateIndex
CREATE INDEX "ix_dataset_version_project_id" ON "dataset_versions"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dataset_version_number" ON "dataset_versions"("dataset_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dataset_version_idempotency" ON "dataset_versions"("dataset_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "ix_test_case_version_id" ON "test_cases"("dataset_version_id");

-- CreateIndex
CREATE INDEX "ix_test_case_project_id" ON "test_cases"("project_id");

-- CreateIndex
CREATE INDEX "ix_test_case_source_trace_id" ON "test_cases"("source_trace_id");

-- CreateIndex
CREATE INDEX "ix_evaluation_dataset_id" ON "evaluations"("dataset_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_evaluation_project_key" ON "evaluations"("project_id", "evaluation_key");

-- CreateIndex
CREATE INDEX "ix_evaluation_run_project_id" ON "evaluation_runs"("project_id");

-- CreateIndex
CREATE INDEX "ix_evaluation_run_project_started_at" ON "evaluation_runs"("project_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "ix_evaluation_run_evaluation_started_at" ON "evaluation_runs"("evaluation_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "ix_evaluation_run_dataset_started_at" ON "evaluation_runs"("dataset_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_run_client_run_id" ON "evaluation_runs"("evaluation_id", "client_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_run_evaluation_run_number" ON "evaluation_runs"("evaluation_id", "run_number");

-- CreateIndex
CREATE INDEX "ix_evaluation_result_project_id" ON "evaluation_results"("project_id");

-- CreateIndex
CREATE INDEX "ix_evaluation_result_trace_id" ON "evaluation_results"("trace_id");

-- CreateIndex
CREATE INDEX "ix_evaluation_result_evaluation_id" ON "evaluation_results"("evaluation_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_result_run_test_case" ON "evaluation_results"("run_id", "test_case_id");

-- CreateIndex
CREATE INDEX "ix_score_project_create_time" ON "scores"("project_id", "create_time" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_score_result_scorer" ON "scores"("result_id", "scorer_name", "scorer_version");

-- AddForeignKey
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_versions" ADD CONSTRAINT "dataset_versions_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_dataset_version_id_fkey" FOREIGN KEY ("dataset_version_id") REFERENCES "dataset_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_runs" ADD CONSTRAINT "evaluation_runs_baseline_run_id_fkey" FOREIGN KEY ("baseline_run_id") REFERENCES "evaluation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evaluation_results" ADD CONSTRAINT "evaluation_results_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "evaluation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scores" ADD CONSTRAINT "scores_result_id_fkey" FOREIGN KEY ("result_id") REFERENCES "evaluation_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Partial indexes (raw SQL — not expressible in the Prisma schema):
CREATE UNIQUE INDEX "uq_dataset_project_lower_name_ui"
    ON "datasets" (project_id, lower(name))
    WHERE client_dataset_id IS NULL;

CREATE INDEX "ix_eval_result_cost_backfill" ON "evaluation_results" ("create_time")
    WHERE "cost_derived_at" IS NULL AND "trace_id" IS NOT NULL;
