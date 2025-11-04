# Constants for log processing

# Fields to skip/ignore when processing log entries
SKIP_LOG_FIELDS = {
    'service_name',
    'github_commit_hash',
    'github_owner',
    'github_repo_name',
    'environment',
    'stack_trace',
    'level',
    'timestamp',
    'trace_id',
    'span_id',
    'ingestionTime',
    'eventId'
}
