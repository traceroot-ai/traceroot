import { Queue } from "bullmq";
import { Redis } from "ioredis";

export interface DetectorRunJob {
  traceId: string;
  detectorIds: string[];
  projectId: string;
}

export interface DetectorRcaFinding {
  detectorId: string;
  detectorName: string;
  summary: string;
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

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export function createRedisConnection(): Redis {
  return new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // required for BullMQ
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

export function createDetectorRcaQueue(connection: Redis): Queue<DetectorRcaJob> {
  return new Queue<DetectorRcaJob>(DETECTOR_RCA_QUEUE, { connection });
}
