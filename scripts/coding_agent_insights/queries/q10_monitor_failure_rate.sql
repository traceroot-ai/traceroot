-- Fix tracker: daily failure rate of one tool in one repo. Placeholders: __TOOL__, __REPO__.
SELECT toDate(s.span_start_time) AS day,
       count() AS calls,
       countIf(s.status = 'ERROR'
               OR (mapContains(s.metadata, 'exit_code') AND s.metadata['exit_code'] != '0')) AS failures,
       round(100 * failures / calls, 1) AS failure_pct
FROM spans AS s
JOIN traces AS t ON t.trace_id = s.trace_id
WHERE s.span_kind = 'TOOL'
  AND s.name = '__TOOL__'
  AND t.git_repo = '__REPO__'
  AND s.span_start_time >= now() - INTERVAL 30 DAY
  AND t.trace_start_time >= now() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day
