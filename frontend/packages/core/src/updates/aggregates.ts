/** What the aggregate query returns for one window, in the worker's naming. */
export interface GroupAggregate {
  name: string;
  traces: number;
  errorTraces: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ModelAggregate {
  model: string;
  calls: number;
  totalTokens: number;
  /** Decimal dollars as text; summed in code with `Number` only for comparison. */
  cost: string;
}

export interface ToolAggregate {
  name: string;
  calls: number;
  errors: number;
}

export interface WindowAggregates {
  start: string;
  end: string;
  totals: {
    traces: number;
    errorTraces: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    gitContextTraces: number;
  };
  llm: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cost: string;
  };
  byModel: ModelAggregate[];
  byModelDay: { model: string; day: string; totalTokens: number; cost: string }[];
  tools: ToolAggregate[];
  workflows: GroupAggregate[];
  refs: GroupAggregate[];
  /** Repositories named by the traces' git context, with their trace counts. */
  repos: { name: string; traces: number }[];
  /** Source files the spans point at (git context), with span and error counts. */
  sourceFiles: { file: string; spans: number; errors: number }[];
  /** Lists that hit the entity cap ("models", "tools", "workflows", "refs"). */
  truncated: string[];
}
