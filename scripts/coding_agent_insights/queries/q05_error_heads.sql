-- Error heads: first 80 characters of failed-tool errors. They come from tool output, so read them privately.
SELECT name AS tool,
       substring(coalesce(status_message, metadata['error'], ''), 1, 80) AS error_head,
       count() AS occurrences,
       uniqExact(trace_id) AS turns_hit
FROM spans
WHERE span_kind = 'TOOL'
  AND (status = 'ERROR' OR (mapContains(metadata, 'exit_code') AND metadata['exit_code'] != '0'))
  AND span_start_time >= now() - INTERVAL 7 DAY
GROUP BY tool, error_head
HAVING occurrences >= 3
ORDER BY occurrences DESC
LIMIT 50
