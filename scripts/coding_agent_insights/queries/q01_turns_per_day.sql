-- Turns, sessions, repos and users per day and agent. Check both agents appear and volume looks right.
SELECT toDate(trace_start_time) AS day,
       name AS agent_turn,
       count() AS turns,
       uniqExact(session_id) AS sessions,
       uniqExact(git_repo) AS repos,
       uniqExact(user_id) AS users
FROM traces
WHERE trace_start_time >= now() - INTERVAL 7 DAY
  AND name IN ('Claude Code Turn', 'Codex Turn')
GROUP BY day, agent_turn
ORDER BY day, agent_turn
