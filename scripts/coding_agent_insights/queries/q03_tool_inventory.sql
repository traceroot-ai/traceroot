-- Tool inventory with both failure encodings (ERROR status and non-zero exit_code). Run it first and adapt the tool names in q07.
SELECT name AS tool,
       count() AS calls,
       countIf(status = 'ERROR') AS error_status,
       countIf(mapContains(metadata, 'exit_code') AND metadata['exit_code'] != '0') AS nonzero_exit
FROM spans
WHERE span_kind = 'TOOL'
  AND span_start_time >= now() - INTERVAL 7 DAY
GROUP BY tool
ORDER BY calls DESC
LIMIT 50
