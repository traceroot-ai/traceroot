-- Turn shape per agent: turns with no tool call (background calls, pure questions) and turns with a failed call.
WITH turn AS (
  SELECT trace_id,
         countIf(span_kind = 'TOOL') AS tool_calls,
         countIf(span_kind = 'TOOL'
                 AND (status = 'ERROR'
                      OR (mapContains(metadata, 'exit_code') AND metadata['exit_code'] != '0'))) AS failed_calls,
         countIf(span_kind = 'LLM') AS model_calls,
         sum(cost) AS cost,
         dateDiff('millisecond', min(span_start_time), max(span_end_time)) AS duration_ms
  FROM spans
  WHERE span_start_time >= now() - INTERVAL 7 DAY
  GROUP BY trace_id
)
SELECT t.name AS agent_turn,
       count() AS turns,
       countIf(turn.tool_calls = 0) AS turns_without_tools,
       countIf(turn.failed_calls > 0) AS turns_with_failed_call,
       quantile(0.5)(turn.tool_calls) AS p50_tool_calls,
       quantile(0.9)(turn.tool_calls) AS p90_tool_calls,
       quantile(0.5)(turn.cost) AS p50_cost,
       quantile(0.9)(turn.cost) AS p90_cost
FROM traces AS t
JOIN turn ON turn.trace_id = t.trace_id
WHERE t.trace_start_time >= now() - INTERVAL 7 DAY
  AND t.name IN ('Claude Code Turn', 'Codex Turn')
GROUP BY agent_turn
