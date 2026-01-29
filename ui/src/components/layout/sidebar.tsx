"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import { useTheme } from "next-themes";
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
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/organizations", label: "Organizations", icon: LayoutGrid },
];

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

export function Sidebar() {
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

  return (
    <div className="flex h-screen w-52 flex-col border-r bg-background">
      {/* Header with logo */}
      <div className="flex h-14 items-center border-b px-3">
        <Link href="/" className="flex items-center gap-2">
          <Image
            src="/images/traceroot_icon.png"
            alt="Traceroot Logo"
            width={28}
            height={28}
            className="h-7 w-7 rounded-md"
          />
          <span className="font-semibold">TraceRoot</span>
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-2 pt-2">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
              pathname === item.href || pathname.startsWith(item.href + "/")
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        ))}
      </nav>

      {/* Bottom section */}
      <div className="border-t p-2 space-y-1">
        {/* Star on GitHub */}
        <a
          href="https://github.com/traceroot-ai/traceroot"
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          <Github className="h-4 w-4" />
          <span className="flex-1">Star on GitHub</span>
        </a>
        {/* Support button */}
        <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
          <LifeBuoy className="h-4 w-4" />
          Support
        </button>

        {/* User menu */}
        <Popover>
          <PopoverTrigger asChild>
            <button className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 hover:bg-accent transition-colors">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-xs font-medium">
                {initials}
              </div>
              <span className="flex-1 text-left text-sm font-medium truncate">
                {displayName}
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="end"
            className="w-48 p-0"
            sideOffset={8}
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
  );
}
