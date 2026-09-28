-- Re-open recent evaluation results for metric derivation.
--
-- `cost_derived_at` means "derivation has RUN for this row", and the periodic backfill
-- selects `WHERE cost_derived_at IS NULL`. That is what lets a genuinely cost-less trace
-- settle after one pass instead of being swept forever — but it also means every row
-- derived by the OLD, cost-only worker is permanently marked done. Adding the token,
-- call-count and latency columns therefore leaves them NULL on all historical results:
-- ingest only self-heals for late SPANS, and the backfill will never revisit a stamped
-- row.
--
-- `backfill_eval_result_costs` only selects results created in the last 7 days, so only
-- those can be handed back to it. Clearing the stamp for a recent result that HAS a trace
-- re-opens it exactly once: it re-derives, re-stamps, and settles — the same one-pass
-- convergence the marker was designed for. Rows with no trace_id are left alone: there is
-- nothing to derive from.
--
-- An older row is never selected by the backfill, so re-opening it would leave it in the
-- `ix_eval_result_cost_backfill` partial index for good with its new columns NULL. Those
-- are left stamped (NULL is the honest reading for a result nobody derived them for), and
-- any older row already stranded unstamped is stamped now to take it out of the index.
-- `cost` is untouched throughout. The cutoff must match the backfill's window in
-- backend/worker/ingest_tasks.py.
--
-- Idempotent: re-running re-opens only rows the backfill will settle again, and the
-- second statement only ever stamps rows outside the window.
UPDATE "evaluation_results" SET "cost_derived_at" = NULL
WHERE "trace_id" IS NOT NULL
  AND "create_time" > now() - interval '7 days';

UPDATE "evaluation_results" SET "cost_derived_at" = now()
WHERE "cost_derived_at" IS NULL
  AND "trace_id" IS NOT NULL
  AND "create_time" <= now() - interval '7 days';
