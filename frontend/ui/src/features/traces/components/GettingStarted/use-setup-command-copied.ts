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

/** The setup command ("Using AI" tab, hand-back step) or the manual walkthrough. */
export type SetupRoute = "command" | "manual";

/** Records `setup_route_chosen` when someone switches between the two routes. */
export function useSetupRouteChosen(
  projectId: string,
  surface: SetupCommandSurface,
): (route: SetupRoute) => void {
  const posthog = usePostHog();
  return useCallback(
    (route: SetupRoute) => {
      posthog?.capture("setup_route_chosen", { project_id: projectId, surface, route });
    },
    [posthog, projectId, surface],
  );
}

/** Records `setup_skipped` when someone leaves a sign-up setup step for the app. */
export function useSetupSkipped(
  projectId: string,
  surface: SetupCommandSurface,
): (step: SetupRoute) => void {
  const posthog = usePostHog();
  return useCallback(
    (step: SetupRoute) => {
      posthog?.capture("setup_skipped", { project_id: projectId, surface, step });
    },
    [posthog, projectId, surface],
  );
}

/** The copy blocks of the manual walkthrough. */
export type SetupSnippet = "sdk_install" | "env" | "sdk_init" | "plugin_install" | "plugin_config";

/** Records `setup_snippet_copied`; pass it to a `CodeBlock`'s `onCopy`. */
export function useSetupSnippetCopied(
  projectId: string,
  surface: SetupCommandSurface,
): (snippet: SetupSnippet, integration: string) => void {
  const posthog = usePostHog();
  return useCallback(
    (snippet: SetupSnippet, integration: string) => {
      posthog?.capture("setup_snippet_copied", {
        project_id: projectId,
        surface,
        snippet,
        integration,
      });
    },
    [posthog, projectId, surface],
  );
}
