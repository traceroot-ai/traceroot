import { revertAlertEmissionState, type AlertEmissionRevert } from "./claim.js";
import { logInfo } from "./log.js";

/** What an emission wrote, which is all its compensation needs to match on. */
export type AlertEmissionFootprint = Omit<AlertEmissionRevert, "error">;

/** A miss is ordinary, not a fault: the alert moved on, and that outranks this rollback. */
export async function revertAlertEmission(
  emission: AlertEmissionFootprint,
  projectId: string,
  reason: string,
): Promise<boolean> {
  const reverted = await revertAlertEmissionState({
    ...emission,
    error: { message: `notification not delivered (${reason})`, at: new Date() },
  });
  const tag = `alert=${emission.alertId} project=${projectId} reason=${reason}`;
  logInfo(
    reverted
      ? `state reverted for re-emission ${tag}`
      : `state left alone, the alert has moved on since it was emitted ${tag}`,
  );
  return reverted;
}
