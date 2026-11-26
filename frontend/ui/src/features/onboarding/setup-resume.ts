import { readStored, writeStored } from "@/lib/hooks/use-local-storage";
import type { CreatedInRun } from "./step-urls";

export type SetupResume = { projectId: string; created: CreatedInRun };
export const setupResumeKey = (userId: string) => `traceroot:onboarding:resume:${userId}`;

export function rememberSetup(userId: string, projectId: string, created: CreatedInRun) {
  writeStored<SetupResume>(setupResumeKey(userId), { projectId, created });
}

export function forgetSetup(userId: string, projectId: string) {
  const key = setupResumeKey(userId);
  // A different tab may already have opened setup for another project.
  if (readStored<SetupResume | null>(key, null)?.projectId === projectId) writeStored(key, null);
}
