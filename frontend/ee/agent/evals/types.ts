/**
 * Shared shapes for the live eval harness.
 *
 * Types only. The package's coverage config excludes `types.ts`, so anything
 * executable placed here would silently drop out of the coverage report.
 */

/** A parsed SSE frame from the agent service's message stream. */
export interface SseFrame {
  event: string;
  data: string;
}

/** An SSE frame whose `data` parsed as JSON, kept for the run transcript. */
export interface SseEvent {
  event: string;
  data: unknown;
}

/** One tool invocation the model made, as reported by `tool_execution_start`. */
export interface EvalToolCall {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
}

/** The matching `tool_execution_end` payload. */
export interface EvalToolResult {
  toolCallId: string;
  name: string;
  isError: boolean;
  result: unknown;
}

/** Everything a single user message produced. */
export interface TurnTranscript {
  sessionId: string;
  message: string;
  toolCalls: EvalToolCall[];
  toolResults: EvalToolResult[];
  assistantText: string;
  events: SseEvent[];
}

/** The user the eval runs as, plus the workspace their fixture project lives in. */
export interface EvalUser {
  id: string;
  email: string;
  workspaceId: string;
}

/** The per-run throwaway project every scenario writes into. */
export interface EvalFixture {
  runId: string;
  user: EvalUser;
  projectId: string;
  projectName: string;
}

export interface DetectorRow {
  id: string;
  name: string;
  template: string;
  prompt: string;
}

export interface WidgetRow {
  id: string;
  dashboardId: string;
  title: string;
  type: string;
  spec: unknown;
}

export interface DashboardRow {
  id: string;
  name: string;
  layout: unknown;
  widgets: WidgetRow[];
}

/** A point-in-time read of everything the write tools can create in a project. */
export interface ProjectRows {
  detectors: DetectorRow[];
  dashboards: DashboardRow[];
}

/** Rows that appeared between two `ProjectRows` reads. */
export interface CreatedRows {
  detectors: DetectorRow[];
  dashboards: DashboardRow[];
  widgets: WidgetRow[];
}

/**
 * The slice of the Prisma client the harness uses.
 *
 * Structural on purpose: the helpers stay unit-testable against plain fakes,
 * and only the live runner has to touch the generated client.
 */
export interface EvalPrisma {
  user: {
    findUnique(args: unknown): Promise<{ id: string; email: string } | null>;
  };
  workspaceMember: {
    findFirst(args: unknown): Promise<{ workspaceId: string } | null>;
  };
  project: {
    create(args: unknown): Promise<{ id: string; name: string }>;
    delete(args: unknown): Promise<unknown>;
  };
  dashboard: {
    create(args: unknown): Promise<{ id: string }>;
    findMany(args: unknown): Promise<DashboardRow[]>;
  };
  detector: {
    findMany(args: unknown): Promise<DetectorRow[]>;
  };
  auditLog: {
    deleteMany(args: unknown): Promise<unknown>;
  };
}

/** Minimal `fetch` shape so tests can inject a fake without DOM lib types. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** What a scenario's assertions get to look at. */
export interface ScenarioContext {
  fixture: EvalFixture;
  /** One entry per user message the scenario sent. */
  turns: TurnTranscript[];
  /** Project rows before the scenario ran. */
  before: ProjectRows;
  /** Project rows after the scenario ran. */
  after: ProjectRows;
  /** Rows the scenario itself created (after minus before). */
  created: CreatedRows;
  /** POSTs a widget spec to the backend query route; resolves to the status. */
  probeWidgetQuery: (spec: unknown) => Promise<number>;
  /** The canonical prompt text a standard detector template carries. */
  canonicalPrompt: (templateId: string) => string;
  prisma: EvalPrisma;
}

export interface Scenario {
  name: string;
  /** What the eval user types, in order. */
  messages: string[];
  /** Send each message in its own fresh session (used by the idempotency check). */
  sessionPerMessage?: boolean;
  assert: (ctx: ScenarioContext) => void | Promise<void>;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  /** The failed assertion (or the transport error) when `passed` is false. */
  error?: string;
  durationMs: number;
  turns: TurnTranscript[];
}
