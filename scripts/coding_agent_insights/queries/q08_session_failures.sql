-- Sessions with many turns and many failures; patterns across turns only show when grouped by session_id.
WITH turn AS (
  SELECT trace_id,
         countIf(span_kind = 'TOOL'
                 AND (status = 'ERROR'
                      OR (mapContains(metadata, 'exit_code') AND metadata['exit_code'] != '0'))) AS failed_calls,
         sum(cost) AS cost
  FROM spans
  WHERE span_start_time >= now() - INTERVAL 7 DAY
  GROUP BY trace_id
)
SELECT t.session_id AS session_id,
       any(t.git_repo) AS repo,
       any(t.name) AS agent_turn,
       count() AS turns,
       sum(turn.failed_calls) AS failed_calls,
       sum(turn.cost) AS cost
FROM traces AS t
JOIN turn ON turn.trace_id = t.trace_id
WHERE t.trace_start_time >= now() - INTERVAL 7 DAY
  AND t.name IN ('Claude Code Turn', 'Codex Turn')
GROUP BY session_id
HAVING turns >= 5
ORDER BY failed_calls DESC
LIMIT 30
