-- Exploration-heavy turns per repo, a proxy for a missing code map or conventions.
WITH turn AS (
  SELECT trace_id,
         countIf(span_kind = 'TOOL' AND name IN ('Read', 'Grep', 'Glob', 'LS')) AS explore_calls,
         countIf(span_kind = 'TOOL' AND name IN ('Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch')) AS edit_calls
  FROM spans
  WHERE span_start_time >= now() - INTERVAL 7 DAY
  GROUP BY trace_id
)
SELECT t.git_repo AS repo,
       count() AS turns,
       countIf(turn.explore_calls >= 10) AS explore_heavy_turns,
       countIf(turn.explore_calls >= 10 AND turn.edit_calls = 0) AS explore_heavy_no_edit,
       round(100 * explore_heavy_turns / turns, 1) AS explore_heavy_pct
FROM traces AS t
JOIN turn ON turn.trace_id = t.trace_id
WHERE t.trace_start_time >= now() - INTERVAL 7 DAY
  AND t.name IN ('Claude Code Turn', 'Codex Turn')
GROUP BY repo
HAVING turns >= 10
ORDER BY explore_heavy_pct DESC
LIMIT 30
