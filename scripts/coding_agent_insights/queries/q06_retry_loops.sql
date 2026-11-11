-- Turns where one tool failed three or more times.
SELECT trace_id,
       name AS tool,
       count() AS failed_calls,
       min(span_start_time) AS first_failure
FROM spans
WHERE span_kind = 'TOOL'
  AND (status = 'ERROR' OR (mapContains(metadata, 'exit_code') AND metadata['exit_code'] != '0'))
  AND span_start_time >= now() - INTERVAL 7 DAY
GROUP BY trace_id, tool
HAVING failed_calls >= 3
ORDER BY failed_calls DESC
LIMIT 50
