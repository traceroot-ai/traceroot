import { useSyncExternalStore } from "react";
import { readStored, writeStored } from "@/lib/hooks/use-local-storage";
import type { CreatedInRun } from "./step-urls";

const prefix = (userId: string) => `traceroot:onboarding:resume:${encodeURIComponent(userId)}:`;
export const setupResumeKey = (userId: string, projectId: string) =>
  prefix(userId) + encodeURIComponent(projectId);
const changed = "traceroot:setup-resume-changed";

type SetupResume = { projectId: string; created: CreatedInRun; visited: number };

export function rememberSetup(userId: string, projectId: string, created: CreatedInRun) {
  writeStored<SetupResume>(setupResumeKey(userId, projectId), {
    projectId,
    created,
    visited: performance.timeOrigin + performance.now(),
  });
  window.dispatchEvent(new Event(changed));
}

export function forgetSetup(userId: string, projectId: string) {
  try {
    window.localStorage.removeItem(setupResumeKey(userId, projectId));
    window.dispatchEvent(new Event(changed));
  } catch {
    // Storage is unavailable in some privacy modes.
  }
}

export function latestSetup(userId: string): SetupResume | null {
  let latest: SetupResume | null = null;
  try {
    const storage = window.localStorage;
    const userPrefix = prefix(userId);
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(userPrefix)) continue;
      const setup = readStored<SetupResume | null>(key, null);
      if (
        setup?.projectId &&
        Number.isFinite(setup.visited) &&
        (!latest || setup.visited > latest.visited)
      ) {
        latest = setup;
      }
    }
  } catch {
    // The header can still render when this browser disables storage.
  }
  return latest;
}

function subscribe(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(changed, listener);
  };
}

export function useSetupResume(userId: string): SetupResume | null {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => JSON.stringify(latestSetup(userId)),
    () => "null",
  );
  return JSON.parse(snapshot);
}
