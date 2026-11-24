"use client";

import type { ReactNode } from "react";
import { Sparkle, Code2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AITab, type CommandCopy } from "./AITab";
import { ManualTab } from "./ManualTab";
import { useSetupRouteChosen, type SetupCommandSurface } from "./use-setup-command-copied";
import { useT } from "@/lib/i18n/provider";

export type SetupTab = "ai" | "manual";

interface SetupTabsProps {
  projectId: string;
  /** Where the tabs are shown: the last step of sign-up, or an empty project. */
  surface: SetupCommandSurface;
  /** The open tab; the caller holds it, since its own heading follows it. */
  tab: SetupTab;
  onTabChange: (tab: SetupTab) => void;
  /** How this surface words the command block. */
  commandCopy: CommandCopy;
  /** The GitHub and Slack connections. Sign-up hides them; they move to their own step. */
  showExternalIntegrations?: boolean;
  /** More ways out under the command, beside the demo project. */
  commandActions?: ReactNode;
  /** Under the manual walkthrough. */
  manualFooter?: ReactNode;
}

/**
 * The two ways to set up tracing, as one component for both places that offer
 * them: the end of sign-up and a project with no traces yet. One copy, so a
 * change to either route reaches both. Each place keeps its own frame and its
 * own wording for the command block.
 *
 * "Using AI" says what the automatic route actually is — a coding agent edits
 * the repository — which is the thing a reader weighs before choosing it.
 */
export function SetupTabs({
  projectId,
  surface,
  tab,
  onTabChange,
  commandCopy,
  showExternalIntegrations = true,
  commandActions,
  manualFooter,
}: SetupTabsProps) {
  const recordRoute = useSetupRouteChosen(projectId, surface);
  const t = useT();

  // Records only an actual change of tab.
  const switchTo = (next: SetupTab) => {
    if (next === tab) return;
    recordRoute(next === "ai" ? "command" : "manual");
    onTabChange(next);
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label={t("tracesSetup.tablistLabel")}
        className="flex items-center gap-1"
      >
        <TabButton active={tab === "ai"} onClick={() => switchTo("ai")}>
          <Sparkle className="h-3.5 w-3.5" />
          {t("tracesSetup.tabAi")}
        </TabButton>
        <TabButton active={tab === "manual"} onClick={() => switchTo("manual")}>
          <Code2 className="h-3.5 w-3.5" />
          {t("tracesSetup.tabManual")}
        </TabButton>
      </div>

      <div className="mt-4">
        {tab === "ai" ? (
          <AITab
            projectId={projectId}
            surface={surface}
            copy={commandCopy}
            showExternalIntegrations={showExternalIntegrations}
            actions={commandActions}
          />
        ) : (
          <div className="space-y-6">
            <ManualTab
              projectId={projectId}
              surface={surface}
              showExternalIntegrations={showExternalIntegrations}
            />
            {manualFooter}
          </div>
        )}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-[2px] px-2.5 py-1.5 text-[13px] font-medium transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
