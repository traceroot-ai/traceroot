-- Failing tools by repo with the number of distinct sessions hit (a pattern in one session is not a pattern).
SELECT t.git_repo AS repo,
       s.name AS tool,
       count() AS calls,
       countIf(s.status = 'ERROR'
               OR (mapContains(s.metadata, 'exit_code') AND s.metadata['exit_code'] != '0')) AS failures,
       round(100 * failures / calls, 1) AS failure_pct,
       uniqExact(s.trace_id) AS turns_hit,
       uniqExact(t.session_id) AS sessions_hit
FROM spans AS s
JOIN traces AS t ON t.trace_id = s.trace_id
WHERE s.span_kind = 'TOOL'
  AND s.span_start_time >= now() - INTERVAL 7 DAY
  AND t.trace_start_time >= now() - INTERVAL 7 DAY
  AND t.name IN ('Claude Code Turn', 'Codex Turn')
GROUP BY repo, tool
HAVING failures >= 3
ORDER BY failures DESC
LIMIT 50
