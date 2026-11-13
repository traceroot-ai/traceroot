/** Row shapes as ClickHouse receives them (column names of `traces` and `spans`). */
export interface TraceRow {
  trace_id: string;
  project_id: string;
  trace_start_time: string;
  name: string;
  user_id: string | null;
  session_id: string | null;
  git_ref: string | null;
  git_repo: string | null;
  input: string | null;
  output: string | null;
  metadata: string | null;
  environment: string;
  source: "user";
  is_evaluation: 0;
}

export interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  project_id: string;
  span_start_time: string;
  span_end_time: string;
  name: string;
  span_kind: "AGENT" | "LLM" | "TOOL";
  status: "OK" | "ERROR";
  status_message: string | null;
  model_name: string | null;
  cost: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  input: string | null;
  output: string | null;
  git_source_file: string | null;
  usage_details: Record<string, number>;
  environment: string;
  source: "user";
  is_evaluation: 0;
  error_type: string;
}

export interface SeededSignal {
  id: string;
  detectorId: string;
  title: string;
  status: "open" | "resolved";
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  /** Hits inside the current window and the one before it. */
  hits: { cur: number; prev: number };
  hitTimes: Date[];
  hitTraceIds: string[];
}

export interface SeededCommit {
  key: string;
  sha?: string;
  at: Date;
  message: string;
  files: Record<string, string>;
  /** The pull request that brought it in, if any. */
  pr?: { number: number; title: string };
  tag?: string;
}

export type Direction = "up" | "down";

export interface PlantedChange {
  id: string;
  project: string;
  kind:
    | "cost_spike"
    | "error_rate_rise"
    | "new_tool"
    | "vanished_tool"
    | "volume_drop"
    | "latency_shift";
  /** The workflow, model or tool the change is about. */
  entity: string;
  direction: Direction | "appeared" | "vanished";
  before: number | null;
  after: number | null;
  /** Relative tolerance a digest's stated magnitude may differ by. */
  tolerance: number;
  note: string;
}

export interface PlantedControl {
  id: string;
  project: string;
  entity: string;
  metrics: string[];
  note: string;
}
