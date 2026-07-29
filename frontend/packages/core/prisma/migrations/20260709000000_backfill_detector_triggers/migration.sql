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
-- Scoped to enabled detectors only. A disabled detector is not firing today, so
-- there is no live behavior to preserve; leaving it trigger-less means that if
-- it is later re-enabled it fails closed (per this fix) rather than silently
-- running on all traces — which is exactly the behavior #1506 asks for. This
-- also matches the issue's acceptance criterion ("any existing enabled
-- trigger-less detector").
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
  AND d."enabled" = TRUE
ON CONFLICT ("detector_id") DO NOTHING;
