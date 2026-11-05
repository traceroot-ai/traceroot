import { Queue } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";

export interface DetectorRunJob {
  traceId: string;
  detectorIds: string[];
  projectId: string;
}

export interface DetectorRcaFinding {
  detectorId: string;
  detectorName: string;
  summary: string;
  /** Set for signal RCAs: the signal this hit started or reopened. */
  signalTitle?: string;
}

export interface DetectorRcaJob {
  findingId: string; // trace-level finding UUID (one per trace)
  projectId: string;
  traceId: string;
  workspaceId: string;
  findings: DetectorRcaFinding[];
  // epoch ms; stamped on the detector rows + keys the digest window. Optional
  // because legacy jobs serialized to Redis before this field existed deserialize
  // without it — scheduleDigestFlush guards the undefined case.
  findingTimestamp?: number;
}

/**
 * An RCA started by signals (ee/signals). It carries only the finding: the job
 * reads which hits need analysis from signal_rcas when it runs, so hits whose
 * signals were opened after it was enqueued are included.
 */
export interface SignalRcaJob {
  kind: "signals";
  findingId: string;
  projectId: string;
}

/** Jobs on the RCA queue: legacy per-finding jobs still in flight, and signal RCAs. */
export type RcaJob = DetectorRcaJob | SignalRcaJob;

export function isSignalRcaJob(job: RcaJob): job is SignalRcaJob {
  return (job as SignalRcaJob).kind === "signals";
}

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

/** The default suits a BullMQ worker connection; producers override it. */
export function createRedisConnection(overrides: RedisOptions = {}): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // required for BullMQ
    ...overrides,
  });
}

export const DETECTOR_RUN_QUEUE = "detector-run";
export const DETECTOR_RCA_QUEUE = "detector-rca";

/**
 * Evaluate a trace once no span has arrived for this long (quiescence debounce).
 * The Python enqueue side mirrors this value (EVALUATOR_DELAY in detector_tasks.py).
 */
export const EVALUATOR_DELAY = 60_000; // ms

export function createDetectorRunQueue(connection: Redis): Queue<DetectorRunJob> {
  return new Queue<DetectorRunJob>(DETECTOR_RUN_QUEUE, { connection });
}

export function createDetectorRcaQueue(connection: Redis): Queue<RcaJob> {
  return new Queue<RcaJob>(DETECTOR_RCA_QUEUE, { connection });
}
