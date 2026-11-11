-- Affected turns against the other turns of the same repo. Placeholders: __IDS__ (quoted, comma-separated trace ids), __REPO__.
WITH turn AS (
  SELECT trace_id,
         count() AS spans,
         countIf(span_kind = 'TOOL') AS tool_calls,
         countIf(span_kind = 'TOOL'
                 AND (status = 'ERROR'
                      OR (mapContains(metadata, 'exit_code') AND metadata['exit_code'] != '0'))) AS failed_calls,
         sum(cost) AS cost,
         dateDiff('millisecond', min(span_start_time), max(span_end_time)) AS duration_ms
  FROM spans
  WHERE span_start_time >= now() - INTERVAL 7 DAY
  GROUP BY trace_id
)
SELECT if(t.trace_id IN (__IDS__), 'affected', 'comparison') AS grp,
       count() AS turns,
       round(avg(turn.tool_calls), 1) AS avg_tool_calls,
       round(avg(turn.failed_calls), 2) AS avg_failed_calls,
       round(100 * countIf(turn.failed_calls > 0) / count(), 1) AS pct_with_failed_call,
       round(quantile(0.5)(turn.duration_ms) / 1000, 1) AS p50_seconds,
       round(avg(turn.cost), 4) AS avg_cost
FROM traces AS t
JOIN turn ON turn.trace_id = t.trace_id
WHERE t.trace_start_time >= now() - INTERVAL 7 DAY
  AND t.name IN ('Claude Code Turn', 'Codex Turn')
  AND t.git_repo = '__REPO__'
GROUP BY grp
ORDER BY grp
