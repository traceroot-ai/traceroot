/** A signal offered to the assignment model. `label` is what the model sees. */
export interface Candidate {
  label: string;
  signalId: string;
  title: string;
  covers: string;
  excludes: string;
  /** The anchor hit's material. */
  example: string;
  status: string;
  hitCount: number;
  criteriaVersion: number;
}

export interface SignalText {
  title: string;
  covers: string;
  excludes: string;
}

/** One model call's usage, recorded as an ai_messages row per round. */
export interface ModelUsage {
  model: string;
  provider: string;
  isByok: boolean;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface ChatAssignAnswer {
  /** A candidate label, or "none". */
  choice: string;
  reason: string;
  newSignal: SignalText | null;
}

export interface JevAssignAnswer {
  choice: string;
  probabilities: Record<string, number>;
}

/** The model calls assignment needs; the job wires real clients, tests wire fakes. */
export interface AssignmentModels {
  chat: {
    assign(material: string, candidates: readonly Candidate[]): Promise<ChatAssignAnswer>;
    write(material: string, candidates: readonly Candidate[]): Promise<SignalText>;
    validate(covers: string, excludes: string, texts: readonly string[]): Promise<boolean[]>;
  };
  /** Present only when the workspace has its own TypeSafe key. */
  jev: {
    assign(material: string, candidates: readonly Candidate[]): Promise<JevAssignAnswer>;
    validate(covers: string, excludes: string, texts: readonly string[]): Promise<boolean[]>;
  } | null;
}

/**
 * The model answered, but not usably: the chat model still gave no valid tool
 * call after its retry, or Jev's answer did not fit the questions. Only this
 * counts toward giving up on a hit. A provider, key, network or database
 * failure is an outage, and the hit waits for it to end.
 */
export class UnusableAnswerError extends Error {}
