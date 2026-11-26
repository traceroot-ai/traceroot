import { readStored, writeStored } from "@/lib/hooks/use-local-storage";
import type { CreatedInRun } from "./step-urls";

export type SetupResume = { projectId: string; created: CreatedInRun };
export const setupResumeKey = (userId: string) => `traceroot:onboarding:resume:${userId}`;

export function remainingSetups(userId: string, projectId: string): SetupResume[] {
  const pending = readStored<SetupResume[]>(setupResumeKey(userId), []);
  return Array.isArray(pending) ? pending.filter((setup) => setup?.projectId !== projectId) : [];
}

export function rememberSetup(userId: string, projectId: string, created: CreatedInRun) {
  writeStored(setupResumeKey(userId), [
    { projectId, created },
    ...remainingSetups(userId, projectId),
  ]);
}

export function forgetSetup(userId: string, projectId: string) {
  writeStored(setupResumeKey(userId), remainingSetups(userId, projectId));
}
