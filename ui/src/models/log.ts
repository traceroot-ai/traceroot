export enum LogLevel {
  DEBUG = "DEBUG",
  INFO = "INFO",
  WARNING = "WARNING",
  ERROR = "ERROR",
  CRITICAL = "CRITICAL",
}

export interface LogEntry {
  time: number;
  function_name: string;
  level: LogLevel;
  message: string;
  file_name: string;
  line_number: number;
  git_url?: string;
  commit_id?: string;
  line?: string;
  lines_above?: string[];
  lines_below?: string[];
}

export interface SpanLog {
  [spanId: string]: LogEntry[];
}

export interface TraceLog {
  [traceId: string]: SpanLog[];
}
