-- Backfill: give every detector without a trigger row an explicit
-- empty-conditions trigger (= "runs on all completed traces").
--
-- The worker now fails closed on a detector with no trigger row instead of
-- treating the absent row as match-all, so a misconfigured detector can no
-- longer silently run an LLM eval on every sampled trace. Converting existing
-- trigger-less detectors into the explicit empty-conditions state first keeps
-- that worker change a no-op for existing data: anything firing today keeps
-- firing, as a UI-visible "runs on all" trigger. The create/edit API always
-- maintains a trigger row, so only legacy/seeded/directly-written detectors
-- are affected.
--
-- App-created ids are cuids, but the column is VARCHAR and any unique string
-- is valid; gen_random_uuid() is built in on PostgreSQL 13+.
-- ON CONFLICT: if a concurrent edit upserts a trigger between the scan and the
-- insert (migrations run against a serving database), skip that detector
-- instead of aborting the migration; also makes manual re-runs idempotent.
INSERT INTO "detector_triggers" ("id", "detector_id", "conditions")
SELECT gen_random_uuid()::text, d."id", '[]'::jsonb
FROM "detectors" d
LEFT JOIN "detector_triggers" dt ON dt."detector_id" = d."id"
WHERE dt."detector_id" IS NULL
ON CONFLICT ("detector_id") DO NOTHING;
