-- Human review V1: one canonical review per (result, dimension).
-- Add the dimension (default "overall"), a lifecycle status, and an update
-- timestamp. All backfilled on existing rows via defaults.
ALTER TABLE "human_scores" ADD COLUMN "dimension" VARCHAR NOT NULL DEFAULT 'overall';
ALTER TABLE "human_scores" ADD COLUMN "status" VARCHAR NOT NULL DEFAULT 'reviewed';
ALTER TABLE "human_scores" ADD COLUMN "update_time" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The model was previously append-only (many reviews per result). Collapse any
-- duplicates to the latest review per (result, dimension) so the unique index can
-- be created; ties broken by id for determinism.
DELETE FROM "human_scores" a
USING "human_scores" b
WHERE a."result_id" = b."result_id"
  AND a."dimension" = b."dimension"
  AND (a."create_time" < b."create_time"
       OR (a."create_time" = b."create_time" AND a."id" < b."id"));

-- One canonical review per (result, dimension); a re-review upserts in place.
CREATE UNIQUE INDEX "uq_human_score_result_dimension" ON "human_scores" ("result_id", "dimension");
