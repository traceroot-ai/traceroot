"use client";

// What a viewer of the public demo workspace may do in settings. This is the
// one place for that rule; WorkspaceSettingsLayout and ProjectSettingsLayout
// ask it for their tab and render the page through SettingsAccessGate.
//
// Demo viewers (members below ADMIN: every visitor) keep the Settings entry
// and every menu item. General pages are readable but every control is
// disabled. The other pages show a demo settings explanation, never an empty
// state. Admins of the demo workspace, and everyone in any other workspace,
// see settings as before. The API routes behind the denied pages return 403
// to demo viewers, so this is presentation, not the security boundary.
import { type ReactNode } from "react";
import { Info } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isDemoWorkspaceViewer } from "@/features/workspaces/utils";
import type { ProjectSettingsTab, WorkspaceSettingsTab } from "./settings-layout";

export type SettingsAccess =
  | { mode: "loading" }
  | { mode: "full" }
  | { mode: "read-only"; scope?: "workspace" | "project" }
  | { mode: "denied"; title: string; message: string };

const denied = (scope: "workspace" | "project", message: string): SettingsAccess => ({
  mode: "denied",
  title: `Demo ${scope} settings`,
  message,
});

const WORKSPACE_DEMO_VIEWER_ACCESS: Record<WorkspaceSettingsTab, SettingsAccess> = {
  general: { mode: "read-only", scope: "workspace" },
  members: denied(
    "workspace",
    "The member list is not available in this demo workspace. You can manage members in your own workspace.",
  ),
  "model-providers": denied(
    "workspace",
    "Model provider settings are not available in this demo workspace. You can connect model providers in your own workspace.",
  ),
  integrations: denied(
    "workspace",
    "Integration settings are not available in this demo workspace. You can connect integrations in your own workspace.",
  ),
  billing: denied(
    "workspace",
    "Billing settings are not available in this demo workspace. You can manage billing in your own workspace.",
  ),
};

const PROJECT_DEMO_VIEWER_ACCESS: Record<ProjectSettingsTab, SettingsAccess> = {
  general: { mode: "read-only", scope: "project" },
  accessKeys: denied(
    "project",
    "API keys are not available in this demo project. You can create API keys in your own project.",
  ),
  // Its notification settings can list team email addresses.
  detectors: denied(
    "project",
    "Detector settings are not available in this demo project. You can explore detectors and findings, or configure detectors in your own project.",
  ),
};

type Membership = { is_demo?: boolean; role?: string } | undefined;

function accessFor(demoViewerAccess: SettingsAccess, workspace: Membership): SettingsAccess {
  if (!workspace) return { mode: "loading" };
  return isDemoWorkspaceViewer(workspace) ? demoViewerAccess : { mode: "full" };
}

/** The access to one workspace settings tab for a user with this workspace membership. */
export function workspaceSettingsAccess(
  tab: WorkspaceSettingsTab,
  workspace: Membership,
): SettingsAccess {
  return accessFor(WORKSPACE_DEMO_VIEWER_ACCESS[tab], workspace);
}

/** The access to one project settings tab for a user with the owning workspace's membership. */
export function projectSettingsAccess(
  tab: ProjectSettingsTab,
  workspace: Membership,
): SettingsAccess {
  return accessFor(PROJECT_DEMO_VIEWER_ACCESS[tab], workspace);
}

function DemoSettingsCard({ title, message }: { title: string; message: string }) {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
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
      return <DemoSettingsCard title={access.title} message={access.message} />;
    case "read-only":
      return (
        <>
          <Card className="mb-4 border-border bg-muted/50 shadow-none">
            <CardContent className="flex items-start gap-2 p-3">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <CardDescription className="text-[13px]">
                Settings in this demo {access.scope ?? "project"} are read-only.
              </CardDescription>
            </CardContent>
          </Card>
          <fieldset disabled className="min-w-0" data-testid="settings-read-only">
            {children}
          </fieldset>
        </>
      );
    case "full":
      return <>{children}</>;
  }
}
