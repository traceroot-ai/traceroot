"use client";

import Link from "next/link";
import { useState } from "react";
import { useParams, usePathname } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useTheme } from "next-themes";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  LifeBuoy,
  ChevronRight,
  Github,
  Sun,
  Moon,
  Monitor,
  MonitorSmartphone,
  Settings,
  UserRoundSearch,
  LogOut,
} from "lucide-react";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { NAV_GROUPS, NAV_HOME, isNavItemActive, navHref, type NavItem } from "./nav-items";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";
import { GitHubStarWidget } from "@/components/layout/GitHubStarWidget";
import { SidebarUpgradeButton } from "@/components/layout/SidebarUpgradeButton";
import { clientEnv } from "@/env.client";
import { exitImpersonation } from "@/features/support/exit";
import { ImpersonationBanner } from "@/features/support/impersonation-banner";
import { isStaff } from "@/lib/support/policy";

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

function NavLink({
  item,
  projectId,
  pathname,
  collapsed,
}: {
  item: NavItem;
  projectId: string;
  pathname: string;
  collapsed: boolean;
}) {
  const Icon = item.icon;
  return (
    <Tooltip key={String(collapsed)}>
      <TooltipTrigger asChild>
        <Link
          href={navHref(projectId, item)}
          aria-current={isNavItemActive(pathname, projectId, item) ? "page" : undefined}
          className={cn(
            "flex items-center gap-2 py-1.5 text-[13px] transition-colors",
            collapsed ? "justify-center px-2" : "px-4",
            isNavItemActive(pathname, projectId, item)
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted",
          )}
        >
          <Icon className={cn("h-3.5 w-3.5 shrink-0")} />
          {!collapsed && item.label}
        </Link>
      </TooltipTrigger>
      {collapsed && (
        <TooltipContent side="right" sideOffset={16}>
          {item.label}
        </TooltipContent>
      )}
    </Tooltip>
  );
}

export function Sidebar({ collapsed = false }: SidebarProps) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
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
          "flex h-dvh shrink-0 flex-col border-r bg-background transition-all duration-200",
          collapsed ? "w-14" : "w-56",
        )}
      >
        <ImpersonationBanner collapsed={collapsed} />

        {/* Header with logo */}
        <div
          className={cn(
            "flex h-11 items-center border-b",
            collapsed ? "justify-center px-2" : "px-4",
          )}
        >
          <Link href="/" className="flex items-center gap-2" aria-label="TraceRoot home">
            {collapsed ? (
              <Logo variant="mark" className="h-[18px] w-[18px]" />
            ) : (
              <>
                <Logo className="h-[18px]" />
                <span className="text-[12px] font-normal text-muted-foreground">
                  {process.env.NEXT_PUBLIC_APP_VERSION ?? "dev"}
                </span>
              </>
            )}
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1 pt-2">
          {projectId ? (
            // Project context navigation, grouped along the product loop
            <>
              <NavLink
                item={NAV_HOME}
                projectId={projectId}
                pathname={pathname}
                collapsed={collapsed}
              />
              {NAV_GROUPS.map((group) => (
                <div key={group.label} role="group" aria-label={group.label}>
                  {collapsed ? (
                    <div className="mx-3 mt-2 border-t border-border" aria-hidden />
                  ) : (
                    <div className="px-4 pb-1 pt-4 text-[12px] font-medium text-muted-foreground">
                      {group.label}
                    </div>
                  )}
                  {group.items.map((item) => (
                    <NavLink
                      key={item.key}
                      item={item}
                      projectId={projectId}
                      pathname={pathname}
                      collapsed={collapsed}
                    />
                  ))}
                </div>
              ))}
            </>
          ) : (
            // Default navigation (Workspaces)
            <Tooltip key={`ws-${collapsed}`}>
              <TooltipTrigger asChild>
                <Link
                  href="/workspaces"
                  className={cn(
                    "flex items-center gap-2 py-1.5 text-[13px] transition-colors",
                    collapsed ? "justify-center px-2" : "px-4",
                    (pathname === "/workspaces" || pathname.startsWith("/workspaces/")) &&
                      !pathname.includes("/settings")
                      ? "bg-muted"
                      : "hover:bg-muted",
                  )}
                >
                  <DOMAIN_ICONS.workspace className="h-3.5 w-3.5 shrink-0" />
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
        <div className="border-t">
          {/* Star widget */}
          {!collapsed && <GitHubStarWidget />}

          {/* Upgrade button - only show when in a project or workspace context */}
          {(projectId || workspaceId) && (
            <SidebarUpgradeButton
              projectId={projectId}
              workspaceId={workspaceId}
              collapsed={collapsed}
            />
          )}

          {/* GitHub link */}
          <Tooltip key={`gh-${collapsed}`}>
            <TooltipTrigger asChild>
              <a
                href={clientEnv.NEXT_PUBLIC_GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex w-full items-center gap-2 py-1.5 text-[13px] transition-colors hover:bg-muted",
                  collapsed ? "justify-center px-2" : "px-4",
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
            <Tooltip key={`settings-${collapsed}`}>
              <TooltipTrigger asChild>
                <Link
                  href={settingsHref}
                  className={cn(
                    "flex w-full items-center gap-2 py-1.5 text-[13px] transition-colors",
                    collapsed ? "justify-center px-2" : "px-4",
                    pathname.includes("/settings") ? "bg-accent" : "hover:bg-muted",
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
          <Tooltip key={`support-${collapsed}`}>
            <TooltipTrigger asChild>
              <Link
                href="/support"
                className={cn(
                  "flex w-full items-center gap-2 py-1.5 text-[13px] transition-colors",
                  collapsed ? "justify-center px-2" : "px-4",
                  pathname === "/support" ? "bg-muted" : "hover:bg-muted",
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
          <Popover open={accountMenuOpen} onOpenChange={setAccountMenuOpen}>
            <PopoverTrigger asChild>
              <button
                aria-label="Account menu"
                className={cn(
                  "flex w-full items-center gap-2 py-1.5 text-[13px] transition-colors hover:bg-muted",
                  collapsed ? "justify-center px-2" : "px-4",
                )}
              >
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[2px] border border-border bg-background text-[12px] font-medium">
                  {initials}
                </div>
                {!collapsed && (
                  <>
                    <span className="flex-1 truncate text-left text-[13px]">{displayName}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="right"
              align="end"
              collisionPadding={0}
              className="w-60 overflow-hidden p-0"
              sideOffset={0}
              alignOffset={0}
            >
              {/* User info */}
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[2px] border border-border bg-background text-[13px] font-medium">
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{displayName}</p>
                  <p className="truncate text-[12px] text-muted-foreground">{user?.email}</p>
                </div>
              </div>

              <div className="h-px bg-border" />

              {/* Theme: three icon choices inline, no submenu to chase */}
              <div>
                <div className="flex h-9 items-center justify-between gap-2 px-4">
                  <span className="text-[13px]">Theme</span>
                  <div className="btn-group" role="radiogroup" aria-label="Theme">
                    {(
                      [
                        ["light", Sun, "Light"],
                        ["dark", Moon, "Dark"],
                        ["system", Monitor, "System"],
                      ] as const
                    ).map(([value, Icon, label]) => {
                      const active =
                        value === "system" ? theme === "system" || !theme : theme === value;
                      return (
                        <button
                          key={value}
                          role="radio"
                          aria-checked={active}
                          aria-label={label}
                          title={label}
                          onClick={() => setTheme(value)}
                          className={cn(
                            "inline-flex h-6 w-7 items-center justify-center transition-colors",
                            active
                              ? "!bg-accent text-foreground"
                              : "text-muted-foreground hover:!bg-muted hover:text-foreground",
                          )}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </button>
                      );
                    })}
                  </div>
                </div>

                {!isImpersonating && isStaff(user?.role) && (
                  <Link
                    href="/admin"
                    onClick={() => setAccountMenuOpen(false)}
                    className="flex h-8 w-full items-center gap-2 rounded-[2px] px-2 text-left text-[13px] transition-colors hover:bg-muted"
                  >
                    <UserRoundSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>Support console</span>
                  </Link>
                )}

                {/* Active sessions — the revoke control for CLI/device logins */}
                <Link
                  href="/account/settings/sessions"
                  onClick={() => setAccountMenuOpen(false)}
                  className="flex h-8 w-full items-center gap-2 rounded-[2px] px-2 text-left text-[13px] transition-colors hover:bg-muted"
                >
                  <MonitorSmartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span>Active sessions</span>
                </Link>

                <div className="h-px bg-border" />

                {/* Sign out */}
                <button
                  className="flex h-8 w-full items-center gap-2 rounded-[2px] px-2 text-left text-[13px] transition-colors hover:bg-muted"
                  onClick={async () => {
                    if (isImpersonating) {
                      await exitImpersonation().catch(() => window.location.assign("/admin"));
                      return;
                    }
                    await authClient.signOut();
                    window.location.href = "/auth/sign-in";
                  }}
                >
                  <LogOut className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  {isImpersonating ? "Exit impersonation" : "Log out"}
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </TooltipProvider>
  );
}
