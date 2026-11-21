/**
 * A Loop's findings, recorded as hits of its hidden detector so the signals
 * pipeline groups them like any detector's: one finding row and one completed
 * run per (finding, trace) in ClickHouse, both with source "loop" so no reader
 * of detector findings, runs or usage counts them, then the detector's
 * assignment round, which places each hit on the signal of its finding key.
 */
import { loopDetectorName, type LoopFinding, type LoopHitData } from "@traceroot/core/loops";
import { mapWithConcurrency } from "../alerts/concurrency.js";
import { writeDetectorFinding, writeDetectorRun } from "../detection/clickhouse-writer.js";
import { hash32, hashToUuid } from "../detection/ids.js";
import { enqueueSignalHits } from "../ee/signals/queue.js";

/**
 * The finding row of one (finding, trace). Not the trace's detector finding id
 * (traceFindingId hashes project and trace only): the detector worker rewrites
 * that row with its own detectors' payload, which would drop this entry.
 */
export function loopFindingId(
  projectId: string,
  traceId: string,
  detectorId: string,
  key: string,
): string {
  return hashToUuid(`${projectId}:${traceId}:loop:${detectorId}:${key}`);
}

/** The run of one (finding, trace): one trace can back several findings of a Loop. */
export function loopFindingRunId(
  projectId: string,
  traceId: string,
  detectorId: string,
  key: string,
): string {
  return hash32(`${projectId}:${traceId}:${detectorId}:${key}`);
}

/** (finding, trace) hits written at once; a run has up to findingsPerRun × tracesPerFinding. */
export const HIT_WRITE_CONCURRENCY = 10;

/**
 * Write every (finding, trace) hit, then enqueue the detector's assignment
 * round once. A hit is written when its finding row and its run both land; the
 * run is what the round reads, so a key is recorded once any of its hits is
 * written, and the run lists it. Failed writes are logged and the rest kept.
 * Returns the recorded keys, each once; throws when no hit was written.
 */
export async function recordLoopFindings(params: {
  projectId: string;
  loop: { name: string; detectorId: string };
  findings: readonly LoopFinding[];
  now?: () => number;
}): Promise<string[]> {
  const { projectId, loop } = params;
  const now = params.now ?? Date.now;
  const detectorName = loopDetectorName(loop.name);
  const seen = new Set<string>();
  const findings = params.findings.filter((f) => !seen.has(f.key) && seen.add(f.key));

  const hits = findings.flatMap((finding) => {
    const timestampMs = now();
    const data: LoopHitData = {
      loopFindingKey: finding.key,
      title: finding.title,
      covers: finding.covers,
    };
    const payload = JSON.stringify([
      { detectorId: loop.detectorId, detectorName, summary: finding.summary, data },
    ]);
    return [...new Set(finding.traceIds)].map((traceId) => ({
      key: finding.key,
      traceId,
      write: async () => {
        const findingId = loopFindingId(projectId, traceId, loop.detectorId, finding.key);
        // The finding first: a run is a waiting hit as soon as it lands.
        await writeDetectorFinding({
          findingId,
          projectId,
          traceId,
          summary: finding.summary,
          payload,
          source: "loop",
          timestampMs,
        });
        await writeDetectorRun({
          runId: loopFindingRunId(projectId, traceId, loop.detectorId, finding.key),
          detectorId: loop.detectorId,
          projectId,
          traceId,
          findingId,
          status: "completed",
          usedInference: false,
          source: "loop",
          timestampMs,
        });
      },
    }));
  });

  const results = await mapWithConcurrency(
    hits,
    HIT_WRITE_CONCURRENCY,
    (hit): Promise<PromiseSettledResult<void>> =>
      hit.write().then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      ),
  );
  const recorded = new Set<string>();
  results.forEach((result, i) => {
    const { key, traceId } = hits[i];
    if (result.status === "fulfilled") recorded.add(key);
    else {
      console.error(
        `[Loops] detector=${loop.detectorId} key=${key} trace=${traceId}: hit not written:`,
        result.reason,
      );
    }
  });
  if (recorded.size === 0) {
    throw new Error(
      `none of ${hits.length} finding hits of detector ${loop.detectorId} were written`,
    );
  }

  // As the detector worker does: the hits are written, so a failed enqueue is
  // left to the sweeper (the partition is marked in Postgres or Redis).
  await enqueueSignalHits({
    projectId,
    detectors: [{ id: loop.detectorId, enableSignals: true }],
    triggered: [{ detectorId: loop.detectorId }],
  }).catch((err) =>
    console.error(`[Loops] Failed to enqueue signal assignment for ${loop.detectorId}:`, err),
  );
  return findings.map((f) => f.key).filter((key) => recorded.has(key));
}
