-- Upgrade: give each opening the successful RCA it already had before openings
-- kept their own copy. A finding whose RCA row is done finished its latest
-- attempt successfully, and that attempt covered every opening of the finding:
-- a new opening resets the row to pending, and completion leaves it pending
-- while any opening is uncovered. Openings linked to a per-finding RCA from
-- before signals are covered too, since that RCA analysed every detector that
-- fired on the trace. An answer a later failed attempt replaced is not in the
-- row any more; those openings keep none and can be analysed again by hand.
-- The per-opening root cause is left empty: it is read only for announcements,
-- which these openings already had.
UPDATE "signal_rcas" sr
SET "result" = dr."result",
    "session_id" = COALESCE(
      (SELECT e."session_id" FROM "detector_rca_executions" e
        WHERE e."finding_id" = dr."finding_id"
        ORDER BY e."attempt" DESC LIMIT 1),
      dr."session_id")
FROM "detector_rcas" dr
WHERE dr."finding_id" = sr."finding_id"
  AND dr."status" = 'done'
  AND dr."result" IS NOT NULL
  AND sr."result" IS NULL;
