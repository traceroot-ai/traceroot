/**
 * Detector background jobs (sandbox LLM eval, etc.).
 *
 * @example
 * import { runDetectionForTrace } from "./detection";
 */
export {
  completeDetectorSandboxEval,
  runDetectionForTrace,
  type DetectorSandboxEvalInput,
  type DetectorConfig,
  type EvalResult,
} from "./sandbox-eval";
export {
  buildSubmitResultTool,
  buildSubmitResultToolForPiAi,
  type SubmitResultInput,
} from "./submit-result-tool";
export { writeDetectorRun, writeDetectorFinding } from "./clickhouse-writer";
