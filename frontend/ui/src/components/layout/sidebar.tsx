"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useTheme } from "next-themes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  LayoutGrid,
  LayoutDashboard,
  LifeBuoy,
  ChevronRight,
  Github,
  Sun,
  Moon,
  Monitor,
  Workflow,
  Settings,
  UserRoundSearch,
  Eye,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { GitHubStarWidget } from "@/components/layout/GitHubStarWidget";
import { SidebarUpgradeButton } from "@/components/layout/SidebarUpgradeButton";
import { getProjectContext } from "@/components/layout/project-context";
import { clientEnv } from "@/env.client";

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  if (email) {
    return email.slice(0, 2).toUpperCase();
  }
  return "U";
}

interface SidebarProps {
  collapsed?: boolean;
}

export function Sidebar({ collapsed = false }: SidebarProps) {
  const pathname = usePathname();
  const { data: sessionData } = authClient.useSession();
  const isImpersonating = !!sessionData?.session?.impersonatedBy;
  const { theme, setTheme } = useTheme();
  const params = useParams<{ projectId?: string; workspaceId?: string }>();

  // Don't show sidebar on auth pages
  if (pathname.startsWith("/auth/")) {
    return null;
  }

  const user = sessionData?.user;
  const initials = getInitials(user?.name, user?.email);
  const displayName = user?.name || user?.email?.split("@")[0] || "User";

  // Project/workspace context from the matched dynamic route params
  const projectId = params?.projectId ?? null;
  const workspaceId = params?.workspaceId ?? null;
  const { isProject } = getProjectContext(pathname);

  // Settings target depends on context: project settings inside a project,
  // workspace settings inside a workspace, hidden elsewhere
  const settingsHref = projectId
    ? `/projects/${projectId}/settings`
    : workspaceId
      ? `/workspaces/${workspaceId}/settings`
      : null;

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          "flex h-screen shrink-0 flex-col border-r bg-background transition-all duration-200",
          collapsed ? "w-14" : "w-48",
        )}
      >
        {isImpersonating && (
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "flex items-center gap-2 border-b border-amber-200 bg-amber-50 dark:border-amber-900/60 dark:bg-amber-950/30",
                  collapsed ? "justify-center px-2 py-2" : "px-3 py-2",
                )}
              >
                <UserRoundSearch className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-amber-800 dark:text-amber-300">
                      {user?.email ?? user?.name}
                    </span>
                    <button
                      className="shrink-0 rounded-md border border-amber-300 bg-white px-1.5 py-0.5 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:bg-transparent dark:text-amber-400 dark:hover:bg-amber-900/50"
                      onClick={async () => {
                        await authClient.admin.stopImpersonating();
                        window.location.reload();
                      }}
                    >
                      Stop
                    </button>
                  </>
                )}
              </div>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={16}>
                <p className="font-medium">Impersonating</p>
                <p className="text-xs text-muted-foreground">{user?.email ?? user?.name}</p>
              </TooltipContent>
            )}
          </Tooltip>
        )}
        {/* Header with logo */}
        <div
          className={cn(
            "flex h-14 items-center border-b",
            collapsed ? "justify-center px-2" : "px-3",
          )}
        >
          <Link href="/" className="flex items-center gap-2">
            <Logo />
            {!collapsed && (
              <>
                <span className="font-semibold">TraceRoot</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {process.env.NEXT_PUBLIC_APP_VERSION}
                </span>
              </>
            )}
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1">
          {projectId ? (
            // Project context navigation
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href={`/projects/${projectId}/traces`}
                    className={cn(
                      "flex items-center gap-2 py-2 text-[13px] transition-colors",
                      collapsed ? "justify-center px-2" : "px-3",
                      pathname.includes("/traces") ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <Workflow className="h-3.5 w-3.5 shrink-0" />
                    {!collapsed && "Tracing"}
                  </Link>
                </TooltipTrigger>
                {collapsed && (
                  <TooltipContent side="right" sideOffset={16}>
                    Tracing
                  </TooltipContent>
                )}
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href={`/projects/${projectId}/detectors`}
                    className={cn(
                      "flex items-center gap-2 py-2 text-[13px] transition-colors",
                      collapsed ? "justify-center px-2" : "px-3",
                      pathname.includes("/detectors") ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <Eye className="h-3.5 w-3.5 shrink-0" />
                    {!collapsed && "Detectors"}
                  </Link>
                </TooltipTrigger>
                {collapsed && (
                  <TooltipContent side="right" sideOffset={16}>
                    Detectors
                  </TooltipContent>
                )}
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    href={`/projects/${projectId}/dashboard`}
                    className={cn(
                      "flex items-center gap-2 py-2 text-[13px] transition-colors",
                      collapsed ? "justify-center px-2" : "px-3",
                      pathname.includes("/dashboard") ? "bg-muted" : "hover:bg-muted/50",
                    )}
                  >
                    <LayoutDashboard className="h-3.5 w-3.5 shrink-0" />
                    {!collapsed && "Dashboard"}
                  </Link>
                </TooltipTrigger>
                {collapsed && (
                  <TooltipContent side="right" sideOffset={16}>
                    Dashboard
                  </TooltipContent>
                )}
              </Tooltip>
            </>
          ) : (
            // Default navigation (Workspaces)
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/workspaces"
                  className={cn(
                    "flex items-center gap-2 py-2 text-[13px] transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    (pathname === "/workspaces" || pathname.startsWith("/workspaces/")) &&
                      !pathname.includes("/settings")
                      ? "bg-muted"
                      : "hover:bg-muted/50",
                  )}
                >
                  <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                  {!collapsed && "Workspaces"}
                </Link>
              </TooltipTrigger>
              {collapsed && (
                <TooltipContent side="right" sideOffset={16}>
                  Workspaces
                </TooltipContent>
              )}
            </Tooltip>
          )}
        </nav>

        {/* Bottom section */}
        <div>
          {/* Star widget */}
          {!collapsed && <GitHubStarWidget />}

          {/* Upgrade button - only show when in project context */}
          {isProject && projectId && (
            <SidebarUpgradeButton projectId={projectId} collapsed={collapsed} />
          )}

          {/* GitHub link */}
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={clientEnv.NEXT_PUBLIC_GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex w-full items-center gap-2 py-2 text-[13px] transition-colors hover:bg-muted/50",
                  collapsed ? "justify-center px-2" : "px-3",
                )}
              >
                <Github className="h-3.5 w-3.5 shrink-0" />
                {!collapsed && <span className="flex-1">GitHub</span>}
              </a>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={16}>
                GitHub
              </TooltipContent>
            )}
          </Tooltip>

          {/* Settings - only show when in a project or workspace context */}
          {settingsHref && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={settingsHref}
                  className={cn(
                    "flex w-full items-center gap-2 py-2 text-[13px] transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    pathname.includes("/settings") ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <Settings className="h-3.5 w-3.5 shrink-0" />
                  {!collapsed && "Settings"}
                </Link>
              </TooltipTrigger>
              {collapsed && (
                <TooltipContent side="right" sideOffset={16}>
                  Settings
                </TooltipContent>
              )}
            </Tooltip>
          )}

          {/* Support link */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                href="/support"
                className={cn(
                  "flex w-full items-center gap-2 py-2 text-[13px] transition-colors",
                  collapsed ? "justify-center px-2" : "px-3",
                  pathname === "/support" ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <LifeBuoy className="h-3.5 w-3.5 shrink-0" />
                {!collapsed && "Support"}
              </Link>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={16}>
                Support
              </TooltipContent>
            )}
          </Tooltip>

          {/* User menu */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className={cn(
                  "flex w-full items-center gap-2 py-2 transition-colors hover:bg-muted/50",
                  collapsed ? "justify-center px-2" : "px-3",
                )}
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-medium">
                  {initials}
                </div>
                {!collapsed && (
                  <>
                    <span className="flex-1 truncate text-left text-sm font-medium">
                      {displayName}
                    </span>
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="end"
              className="w-48 p-0"
              sideOffset={0}
              alignOffset={0}
            >
              {/* User info */}
              <div className="flex items-center gap-2 px-3 py-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-muted text-sm font-medium">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{displayName}</p>
                  <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
                </div>
              </div>

              <div className="h-px bg-border" />

              {/* Theme selector with submenu */}
              <div className="p-1">
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent">
                      <span>Theme</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent side="right" align="start" className="w-28 p-1" sideOffset={4}>
                    <button
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        theme === "light" ? "bg-accent" : "hover:bg-accent",
                      )}
                      onClick={() => setTheme("light")}
                    >
                      <span>Light</span>
                      <Sun className="h-4 w-4" />
                    </button>
                    <button
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        theme === "dark" ? "bg-accent" : "hover:bg-accent",
                      )}
                      onClick={() => setTheme("dark")}
                    >
                      <span>Dark</span>
                      <Moon className="h-4 w-4" />
                    </button>
                    <button
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        theme === "system" || !theme ? "bg-accent" : "hover:bg-accent",
                      )}
                      onClick={() => setTheme("system")}
                    >
                      <span>System</span>
                      <Monitor className="h-4 w-4" />
                    </button>
                  </PopoverContent>
                </Popover>

                {/* Sign out */}
                <button
                  className="flex w-full items-center justify-center rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
                  onClick={async () => {
                    await authClient.signOut();
                    window.location.href = "/auth/sign-in";
                  }}
                >
                  Log Out
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </TooltipProvider>
  );
}
