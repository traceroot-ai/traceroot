"use client";

import { useCallback } from "react";
import { usePostHog } from "posthog-js/react";

/**
 * Where the setup command was copied: the hand-back step at the end of sign-up,
 * or the getting-started panel of a project that has no traces yet.
 */
export type SetupCommandSurface = "onboarding" | "project";

/**
 * The copy handler for a setup command: records `setup_command_copied`.
 *
 * Hand it to the command's `CodeBlock` as `onCopy`, which runs only after the
 * clipboard write succeeded, so a copy the browser refused records nothing. The
 * page shows nothing new; the button's check mark stays the only feedback.
 *
 * Read next to the project's first trace, this separates people who stopped
 * before copying the command from people who copied it and got stuck after.
 */
export function useSetupCommandCopied(projectId: string, surface: SetupCommandSurface): () => void {
  const posthog = usePostHog();
  return useCallback(() => {
    posthog?.capture("setup_command_copied", { project_id: projectId, surface });
  }, [posthog, projectId, surface]);
}
