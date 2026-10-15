"use client";

// What a viewer of the public demo workspace may do in settings. This is the
// one place for that rule; settings pages ask it through the two hooks and
// pass the answer to SettingsLayout.
//
// Demo viewers (members below ADMIN: every visitor) keep the Settings entry
// and every menu item. General pages are readable but every control is
// disabled. The other pages show an "Access denied" card, never an empty
// state. Admins of the demo workspace, and everyone in any other workspace,
// see settings as before. The API routes behind the denied pages return 403
// to demo viewers, so this is presentation, not the security boundary.
import { type ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";
import { isDemoWorkspaceViewer } from "@/features/workspaces/utils";

export type SettingsSection =
  | "workspace-general"
  | "members"
  | "model-providers"
  | "integrations"
  | "billing"
  | "project-general"
  | "access-keys"
  | "detectors";

export type SettingsAccess =
  | { mode: "loading" }
  | { mode: "full" }
  | { mode: "read-only" }
  | { mode: "denied"; message: string };

const denied = (message: string): SettingsAccess => ({ mode: "denied", message });

const DEMO_VIEWER_ACCESS: Record<SettingsSection, SettingsAccess> = {
  "workspace-general": { mode: "read-only" },
  members: denied("You do not have permission to view the members of this workspace."),
  "model-providers": denied(
    "You do not have permission to view the model providers of this workspace.",
  ),
  integrations: denied("You do not have permission to view the integrations of this workspace."),
  billing: denied("You do not have permission to view the billing settings of this workspace."),
  "project-general": { mode: "read-only" },
  "access-keys": denied("You do not have permission to view the API keys of this project."),
  // Its notification settings can list team email addresses.
  detectors: denied("You do not have permission to view the detector settings of this project."),
};

/** The access to one settings section for a user with this workspace membership. */
export function settingsAccess(
  section: SettingsSection,
  workspace: { is_demo?: boolean; role?: string } | undefined,
): SettingsAccess {
  if (!workspace) return { mode: "loading" };
  return isDemoWorkspaceViewer(workspace) ? DEMO_VIEWER_ACCESS[section] : { mode: "full" };
}

// If the membership cannot be read, show the page as before and let the page
// and its API calls deal with the error, rather than an empty screen.
export function useWorkspaceSettingsAccess(
  workspaceId: string,
  section: SettingsSection,
): SettingsAccess {
  const { data: workspace, isError } = useWorkspace(workspaceId);
  return isError ? { mode: "full" } : settingsAccess(section, workspace);
}

export function useProjectSettingsAccess(
  projectId: string,
  section: SettingsSection,
): SettingsAccess {
  const { data: project, isError: projectError } = useProject(projectId);
  const { data: workspace, isError } = useWorkspace(project?.workspace_id ?? "");
  return projectError || isError ? { mode: "full" } : settingsAccess(section, workspace);
}

function AccessDeniedCard({ message }: { message: string }) {
  return (
    <Card className="max-w-xl" role="alert">
      <CardHeader>
        <CardTitle className="text-base">Access denied</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  );
}

/**
 * Renders a settings page for the given access: nothing until the membership
 * is known, the denied card, the page with every control disabled, or the page
 * as it is. A disabled <fieldset> turns off every input and button inside it,
 * dialog triggers included, so the pages need no per-control flags.
 */
export function SettingsAccessGate({
  access,
  children,
}: {
  access: SettingsAccess;
  children: ReactNode;
}) {
  switch (access.mode) {
    case "loading":
      return null;
    case "denied":
      return <AccessDeniedCard message={access.message} />;
    case "read-only":
      return (
        <fieldset disabled className="min-w-0" data-testid="settings-read-only">
          {children}
        </fieldset>
      );
    case "full":
      return <>{children}</>;
  }
}
