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
6. Write one monitor query that tracks the pattern after the fix. It must be valid for the public SQL schema: only the tables spans and traces, the columns listed by "traceroot sql schema", a time bound on span_start_time or trace_start_time, and no prompt or output text. It must run, so keep it simple.
7. List three trace ids that show the pattern best, and one turn from the comparison group that looks similar but went fine.
8. Rate your confidence (high, medium, low) and say what evidence would change it.

Never repeat secrets, tokens, keys or personal data you see in a trace; describe them as "a credential".
