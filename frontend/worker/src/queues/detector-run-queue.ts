import { Queue } from "bullmq";
import IORedis from "ioredis";

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
  projectName: string;
  findings: DetectorRcaFinding[];
}

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

export function createRedisConnection(): IORedis {
  return new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null, // required for BullMQ
  });
}

export const DETECTOR_RUN_QUEUE = "detector-run";
export const DETECTOR_RCA_QUEUE = "detector-rca";

export function createDetectorRunQueue(connection: IORedis): Queue<DetectorRunJob> {
  return new Queue<DetectorRunJob>(DETECTOR_RUN_QUEUE, { connection });
}

export function createDetectorRcaQueue(connection: IORedis): Queue<DetectorRcaJob> {
  return new Queue<DetectorRcaJob>(DETECTOR_RCA_QUEUE, { connection });
}
