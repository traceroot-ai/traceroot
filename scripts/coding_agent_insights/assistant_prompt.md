You are helping a team change its coding-agent setup so that Claude Code and Codex fail less in our repositories. Work at repo and team level; never name or compare individual developers.

Candidate pattern: <one line, for example "retry loops on the test command in org/repo">
Window: <dates>. Affected trace ids: <the ids>.
SQL results I ran (spans and traces only, no prompt or output text): <paste Q4-Q9 rows>

Do this, in order:
1. Read the findings for the affected traces (get_finding_by_trace) and open at least five of the traces with their span input and output (get_trace with full fields). Say how many of the five show the pattern. Count only what you saw in a trace.
2. Name the pattern in one sentence that does not mention file names, ids or people.
3. Give the comparison group: which turns, how many, and how they differ from the affected turns on failed calls, tool calls, duration and cost. Use my SQL results; say plainly if the difference is small or absent.
4. Estimate frequency: affected turns, sessions and repos, as a share of all turns in the window.
5. Propose one concrete fix and its kind: an AGENTS.md or CLAUDE.md rule, a skill, a hook, or a tool. Write the exact text of the rule or the outline of the hook. I will check whether the repository already has such a rule; do not claim it is missing.
6. Write one monitor query that tracks the pattern after the fix. It must run on the public SQL gateway as written, and you cannot run it to check, so stay inside this schema. Only two tables exist, each needs a time bound on its start time. spans: span_id, trace_id, parent_span_id, span_start_time, span_end_time, duration_ms, name, span_kind, status, status_message, model_name, cost, input_tokens, output_tokens, total_tokens, environment, metadata, git_source_file, git_source_line, git_source_function, error_type. traces: trace_id, trace_start_time, name, user_id, session_id, git_ref, git_repo, environment, metadata. There are no input or output columns, so the query cannot match prompt or output text; match on name, span_kind, status, metadata (a map: metadata['coding_agent'], metadata['exit_code']) or counts. Use toDate(...) for days, not date(...). A tool span counts as failed only when its status is ERROR (Claude Code) or its metadata exit_code is not 0 (Codex). If your pattern is invisible to that, say so and have the monitor count volume instead. Follow the shape of this query: SELECT toDate(s.span_start_time) AS day, count() AS calls, countIf(s.status = 'ERROR') AS failures FROM spans AS s WHERE s.span_kind = 'TOOL' AND s.name = 'Bash' AND s.span_start_time >= now() - INTERVAL 30 DAY GROUP BY day ORDER BY day.
7. List three trace ids that show the pattern best, and one turn from the comparison group that looks similar but went fine.
8. Rate your confidence (high, medium, low) and say what evidence would change it.

Never repeat secrets, tokens, keys or personal data you see in a trace; describe them as "a credential".
