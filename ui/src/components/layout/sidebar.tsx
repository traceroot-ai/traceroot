"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  LayoutGrid,
  LifeBuoy,
  ChevronRight,
  Github,
  Sun,
  Moon,
  Monitor,
  Workflow,
  Settings,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function Logo() {
  const { theme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && theme === "dark";

  return (
    <div
      className={cn(
        "rounded-md p-1.5",
        isDark ? "bg-white" : "bg-black"
      )}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        className={cn(
          "h-5 w-5",
          isDark ? "text-black" : "text-white"
        )}
        viewBox="0 0 23 23"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11.5" cy="3.5" r="2.5" />
        <circle cx="5.5" cy="11.5" r="2.5" />
        <circle cx="17.5" cy="11.5" r="2.5" />
        <line x1="11.5" y1="6" x2="11.5" y2="8" />
        <line x1="11.5" y1="8" x2="7.5" y2="10" />
        <line x1="11.5" y1="8" x2="15.5" y2="10" />
        <line x1="5.5" y1="14" x2="5.5" y2="17" />
        <line x1="17.5" y1="14" x2="17.5" y2="17" />
        <circle cx="5.5" cy="19.5" r="2.5" />
        <circle cx="17.5" cy="19.5" r="2.5" />
      </svg>
    </div>
  );
}

// Check if we're in a project context by looking at the path structure
function getProjectContext(pathname: string): { isProject: boolean; projectId: string | null } {
  // Known non-project routes
  const nonProjectRoutes = ['/organizations', '/auth', '/onboarding', '/'];

  // Check if path starts with any known non-project route
  for (const route of nonProjectRoutes) {
    if (pathname === route || (route !== '/' && pathname.startsWith(route + '/'))) {
      return { isProject: false, projectId: null };
    }
  }

  // If we get here, assume it's a project route like /[projectId]/traces
  // Extract the projectId from the path (first segment after /)
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0) {
    return { isProject: true, projectId: segments[0] };
  }

  return { isProject: false, projectId: null };
}

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
  const { data: session } = useSession();
  const { theme, setTheme } = useTheme();

  // Don't show sidebar on auth pages
  if (pathname.startsWith("/auth/")) {
    return null;
  }

  const user = session?.user;
  const initials = getInitials(user?.name, user?.email);
  const displayName = user?.name || user?.email?.split("@")[0] || "User";

  // Get project context
  const { isProject, projectId } = getProjectContext(pathname);

  return (
    <TooltipProvider delayDuration={0}>
      <div
        className={cn(
          "flex h-screen flex-col border-r bg-background transition-all duration-200",
          collapsed ? "w-14" : "w-40"
        )}
      >
        {/* Header with logo */}
        <div className={cn("flex h-14 items-center border-b", collapsed ? "justify-center px-2" : "px-3")}>
          <Link href="/" className="flex items-center gap-2">
            <Logo />
            {!collapsed && <span className="font-semibold">TraceRoot</span>}
          </Link>
        </div>

        {/* Navigation */}
        <nav className="flex-1">
          {isProject && projectId ? (
            // Project context navigation
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={`/${projectId}/traces`}
                  className={cn(
                    "flex items-center gap-2 py-2 text-[13px] transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    pathname.includes("/traces")
                      ? "bg-muted"
                      : "hover:bg-muted/50"
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
          ) : (
            // Default navigation (Organizations)
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/organizations"
                  className={cn(
                    "flex items-center gap-2 py-2 text-[13px] transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    pathname === "/organizations" || pathname.startsWith("/organizations/")
                      ? "bg-muted"
                      : "hover:bg-muted/50"
                  )}
                >
                  <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
                  {!collapsed && "Organizations"}
                </Link>
              </TooltipTrigger>
              {collapsed && (
                <TooltipContent side="right" sideOffset={16}>
                  Organizations
                </TooltipContent>
              )}
            </Tooltip>
          )}
        </nav>

        {/* Bottom section */}
        <div>
          {/* Settings - only show when in project context */}
          {isProject && projectId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href={`/${projectId}/settings`}
                  className={cn(
                    "flex w-full items-center gap-2 py-2 text-[13px] transition-colors",
                    collapsed ? "justify-center px-2" : "px-3",
                    pathname.includes("/settings")
                      ? "bg-muted"
                      : "hover:bg-muted/50"
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

          {/* Star on GitHub */}
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href="https://github.com/traceroot-ai/traceroot"
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "flex w-full items-center gap-2 py-2 text-[13px] hover:bg-muted/50 transition-colors",
                  collapsed ? "justify-center px-2" : "px-3"
                )}
              >
                <Github className="h-3.5 w-3.5 shrink-0" />
                {!collapsed && <span className="flex-1">Star on GitHub</span>}
              </a>
            </TooltipTrigger>
            {collapsed && (
              <TooltipContent side="right" sideOffset={16}>
                Star on GitHub
              </TooltipContent>
            )}
          </Tooltip>

          {/* Support button */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className={cn(
                  "flex w-full items-center gap-2 py-2 text-[13px] hover:bg-muted/50 transition-colors",
                  collapsed ? "justify-center px-2" : "px-3"
                )}
              >
                <LifeBuoy className="h-3.5 w-3.5 shrink-0" />
                {!collapsed && "Support"}
              </button>
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
                  "flex w-full items-center gap-2 py-2 hover:bg-muted/50 transition-colors",
                  collapsed ? "justify-center px-2" : "px-3"
                )}
              >
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-xs font-medium shrink-0">
                  {initials}
                </div>
                {!collapsed && (
                  <>
                    <span className="flex-1 text-left text-sm font-medium truncate">
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
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{displayName}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {user?.email}
                  </p>
                </div>
              </div>

              <div className="h-px bg-border" />

              {/* Theme selector with submenu */}
              <div className="p-1">
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors">
                      <span>Theme</span>
                      <ChevronRight className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    side="right"
                    align="start"
                    className="w-28 p-1"
                    sideOffset={4}
                  >
                    <button
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        theme === "light" ? "bg-accent" : "hover:bg-accent"
                      )}
                      onClick={() => setTheme("light")}
                    >
                      <span>Light</span>
                      <Sun className="h-4 w-4" />
                    </button>
                    <button
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        theme === "dark" ? "bg-accent" : "hover:bg-accent"
                      )}
                      onClick={() => setTheme("dark")}
                    >
                      <span>Dark</span>
                      <Moon className="h-4 w-4" />
                    </button>
                    <button
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors",
                        theme === "system" || !theme ? "bg-accent" : "hover:bg-accent"
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
                  className="flex w-full items-center justify-center rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors"
                  onClick={() => signOut({ callbackUrl: "/auth/sign-in" })}
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
