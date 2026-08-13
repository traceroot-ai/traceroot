-- CreateTable
CREATE TABLE "alerts" (
    "id" VARCHAR NOT NULL,
    "project_id" VARCHAR NOT NULL,
    "name" VARCHAR NOT NULL,
    "view" VARCHAR NOT NULL,
    "measure" VARCHAR NOT NULL,
    "aggregation" VARCHAR NOT NULL,
    "filters" JSONB NOT NULL,
    "window" VARCHAR NOT NULL,
    "threshold_operator" VARCHAR NOT NULL,
    "threshold" DECIMAL(65,30) NOT NULL,
    "renotify" JSONB NOT NULL,
    "status" VARCHAR NOT NULL DEFAULT 'ACTIVE',
    "severity" VARCHAR NOT NULL DEFAULT 'UNKNOWN',
    "severity_changed_at" TIMESTAMP(6),
    "alerted_at" TIMESTAMP(6),
    "last_evaluated_at" TIMESTAMP(6),
    "next_run_at" TIMESTAMP(6),
    "last_claimed_at" TIMESTAMP(6),
    "created_by" VARCHAR NOT NULL,
    "create_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "update_time" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_alert_project_id" ON "alerts"("project_id");

-- CreateIndex
CREATE INDEX "ix_alert_status_next_run_at" ON "alerts"("status", "next_run_at");

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
