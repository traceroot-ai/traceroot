"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Telescope,
  LibraryBig,
  Settings,
  ArrowRightFromLine,
  ArrowLeftFromLine,
  Mail,
  MessageCircle,
  BookText,
  Moon,
  Sun,
} from "lucide-react";
import { FaUser } from "react-icons/fa";
import { RxCross1 } from "react-icons/rx";

import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  useSidebar,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { useUser } from "../../hooks/useUser";
import { useSubscription } from "../../hooks/useSubscription";

function LogoComponent() {
  const { state } = useSidebar();
  const { theme } = useTheme();

  return (
    <div
      className={`flex items-center rounded-md m-2 hover:bg-zinc-300 dark:hover:bg-zinc-700 transition-colors
    ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}
    >
      <Link
        href="/"
        className={`flex items-center group ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}
      >
        <div
          className={`${theme === "dark" ? "bg-white" : "bg-black"} rounded-lg p-1.5`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className={`h-6 w-6 ${theme === "dark" ? "text-black" : "text-white"}`}
            viewBox="0 0 22 22"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="3" r="2.5" />
            <circle cx="5" cy="11" r="2.5" />

            {/* Right node */}
            <circle cx="17" cy="11" r="2.5" />

            {/* Connecting lines from root */}
            <line x1="11" y1="5.5" x2="11" y2="7.5" />
            <line x1="11" y1="7.5" x2="7" y2="9.5" />
            <line x1="11" y1="7.5" x2="15" y2="9.5" />

            {/* Connecting lines to leaf nodes */}
            <line x1="5" y1="13.5" x2="5" y2="16.5" />
            <line x1="17" y1="13.5" x2="17" y2="16.5" />

            {/* Leaf nodes */}
            <circle cx="5" cy="19" r="2.5" />
            <circle cx="17" cy="19" r="2.5" />
          </svg>
        </div>
        {state === "expanded" && (
          <div className="flex flex-col">
            <span className="font-semibold text-sm text-neutral-800 dark:text-neutral-200">
              TraceRoot.AI
            </span>
            <span className="font-semibold text-sm text-[#fb923c]">
              YCombinator
            </span>
          </div>
        )}
      </Link>
    </div>
  );
}

function ExploreComponent() {
  const { state } = useSidebar();
  const pathname = usePathname();
  const { hasActiveSubscription } = useSubscription();

  const isDisabled = !hasActiveSubscription;

  return (
    <SidebarMenuButton
      asChild={!isDisabled}
      isActive={pathname === "/explore"}
      tooltip={isDisabled ? "Select a plan to access exploration features" : "Exploration"}
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"} ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
      disabled={isDisabled}
    >
      {isDisabled ? (
        <div className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}>
          <Telescope className="w-5 h-5 flex-shrink-0" />
          {state === "expanded" && <span>Explore</span>}
        </div>
      ) : (
        <Link
          href="/explore"
          className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}
        >
          <Telescope className="w-5 h-5 flex-shrink-0" />
          {state === "expanded" && <span>Explore</span>}
        </Link>
      )}
    </SidebarMenuButton>
  );
}

function IntegrateComponent() {
  const { state } = useSidebar();
  const pathname = usePathname();
  const { hasActiveSubscription } = useSubscription();

  const isDisabled = !hasActiveSubscription;

  return (
    <SidebarMenuButton
      asChild={!isDisabled}
      isActive={pathname === "/integrate"}
      tooltip={isDisabled ? "Select a plan to access integration features" : "Integration"}
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"} ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
      disabled={isDisabled}
    >
      {isDisabled ? (
        <div className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}>
          <LibraryBig className="w-5 h-5 flex-shrink-0" />
          {state === "expanded" && <span>Integrate</span>}
        </div>
      ) : (
        <Link
          href="/integrate"
          className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}
        >
          <LibraryBig className="w-5 h-5 flex-shrink-0" />
          {state === "expanded" && <span>Integrate</span>}
        </Link>
      )}
    </SidebarMenuButton>
  );
}

function NeedHelpComponent() {
  const { state } = useSidebar();
  const [copied, setCopied] = useState(false);

  return (
    <Dialog>
      <DialogTrigger asChild>
        <SidebarMenuButton
          isActive={false}
          tooltip="Need Help"
          className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
        >
          <MessageCircle className="w-5 h-5 flex-shrink-0" />
          {state === "expanded" && (
            <div className="flex items-center gap-2">
              <span>Need Help</span>
            </div>
          )}
        </SidebarMenuButton>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Need Help</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col space-y-3 pt-6">
          <Button
            variant="outline"
            className="w-full text-sm justify-center cursor-pointer hover:bg-muted/50"
            onClick={() => {
              navigator.clipboard.writeText("founders@traceroot.ai");
              setCopied(true);
              setTimeout(() => setCopied(false), 1000);
            }}
          >
            <div className="flex items-center justify-between w-full">
              <Mail className="w-4 h-4" />
              <span className="flex-1 text-center">founders@traceroot.ai</span>
              {copied ? (
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <polyline points="20,6 9,17 4,12"></polyline>
                </svg>
              ) : (
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  strokeWidth="2"
                >
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              )}
            </div>
          </Button>

          <Button asChild variant="outline" className="w-full text-sm">
            <a
              href="https://cal.com/traceroot"
              target="_blank"
              rel="noopener noreferrer"
            >
              Book a call
            </a>
          </Button>

          <Button asChild variant="outline" className="w-full text-sm">
            <a
              href="https://discord.gg/tPyffEZvvJ"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between"
            >
              <span>We're online on Discord</span>
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DocumentationComponent() {
  const { state } = useSidebar();
  return (
    <SidebarMenuButton
      asChild
      isActive={false}
      tooltip="Documentation"
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      <a
        href="https://docs.traceroot.ai"
        target="_blank"
        rel="noopener noreferrer"
        className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}
      >
        <BookText className="w-5 h-5 flex-shrink-0" />
        {state === "expanded" && <span>Documentation</span>}
      </a>
    </SidebarMenuButton>
  );
}


function SettingsComponent() {
  const { state } = useSidebar();
  const pathname = usePathname();
  const { hasActiveSubscription } = useSubscription();

  const isDisabled = !hasActiveSubscription;

  return (
    <SidebarMenuButton
      asChild={!isDisabled}
      isActive={pathname === "/settings"}
      tooltip={isDisabled ? "Select a plan to access settings" : "Settings"}
      className={`flex items-center rounded-md p-2 mb-1 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-1"} ${isDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
      disabled={isDisabled}
    >
      {isDisabled ? (
        <div className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-1"}`}>
          <Settings className="w-5 h-5 flex-shrink-0" />
          {state === "expanded" && <span>Settings</span>}
        </div>
      ) : (
        <Link
          href="/settings"
          className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-1"}`}
        >
          <Settings className="w-5 h-5 flex-shrink-0" />
          {state === "expanded" && <span>Settings</span>}
        </Link>
      )}
    </SidebarMenuButton>
  );
}

function ProfileComponent() {
  const { user, avatarLetter, isLoading, logout } = useUser();
  const { state } = useSidebar();

  const handleSignOut = () => {
    logout();
    window.location.href = "https://auth.traceroot.ai/";
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center animate-pulse">
          <div className="w-4 h-4 bg-gray-400 dark:bg-gray-300 rounded-full"></div>
        </div>
        {state === "expanded" && (
          <div className="flex flex-col animate-pulse">
            <div className="font-semibold text-sm bg-gray-400 dark:bg-gray-300 rounded-full w-16 mb-1"></div>
            <div className="font-semibold text-sm bg-gray-400 dark:bg-gray-300 rounded-full w-20"></div>
          </div>
        )}
      </div>
    );
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className={`flex items-center gap-2 hover:bg-sidebar-accent transition-colors h-auto p-2 ${
            state === "collapsed" ? "justify-center" : "justify-start"
          }`}
        >
          <div
            key={`avatar-${avatarLetter || "no-letter"}`}
            className="w-8 h-8 rounded-md flex items-center justify-center"
            title="User Profile"
          >
            {avatarLetter ? (
              <span
                className="text-sidebar-accent-foreground font-semibold text-sm"
                style={{ zIndex: 100 }}
              >
                {avatarLetter}
              </span>
            ) : (
              <FaUser className="text-sidebar-foreground" size={14} />
            )}
          </div>
          {state === "expanded" && (
            <div className="flex flex-col flex-1 min-w-0 text-left">
              <span className="text-xs font-medium truncate">
                {user?.given_name || user?.email?.split("@")[0] || "First Name"}
              </span>
              <span className="text-xs truncate">
                {user?.family_name || "Last Name"}
              </span>
            </div>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-sidebar-accent/50 flex items-center justify-center">
              {avatarLetter ? (
                <span className="text-sidebar-accent-foreground font-semibold text-2xl">
                  {avatarLetter}
                </span>
              ) : (
                <FaUser className="text-sidebar-foreground" size={24} />
              )}
            </div>
            <DialogTitle className="text-center">
              {user?.given_name
                ? `Hello ${user.given_name}!`
                : user?.email
                  ? `Hello ${user.email}!`
                  : "Welcome!"}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="flex flex-col space-y-4 pt-4">
          {user?.email && (
            <div className="grid gap-4">
              <div className="grid gap-3">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  value={user.email || ""}
                  readOnly
                  className="bg-muted"
                />
              </div>
              {user?.given_name && (
                <div className="grid gap-3">
                  <Label htmlFor="given-name">Given Name</Label>
                  <Input
                    id="given-name"
                    name="given-name"
                    value={user.given_name || ""}
                    readOnly
                    className="bg-muted"
                  />
                </div>
              )}
              {user?.family_name && (
                <div className="grid gap-3">
                  <Label htmlFor="family-name">Family Name</Label>
                  <Input
                    id="family-name"
                    name="family-name"
                    value={user.family_name || ""}
                    readOnly
                    className="bg-muted"
                  />
                </div>
              )}
              {user?.company && (
                <div className="grid gap-3">
                  <Label htmlFor="company">Company</Label>
                  <Input
                    id="company"
                    name="company"
                    value={user.company || ""}
                    readOnly
                    className="bg-muted"
                  />
                </div>
              )}
            </div>
          )}

          <DialogFooter className="flex justify-center">
            {!user ? (
              <Button asChild className="mx-auto">
                <a
                  href="https://auth.traceroot.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Sign In / Register
                </a>
              </Button>
            ) : (
              <>
                <DialogClose asChild>
                  <Button variant="outline">Close</Button>
                </DialogClose>
                <Button onClick={handleSignOut} variant="destructive">
                  <RxCross1 className="mr-2 h-4 w-4" />
                  Sign Out
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DarkModeToggle() {
  const { theme, setTheme } = useTheme();
  const { state } = useSidebar();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const toggleDarkMode = () => {
    setTheme(theme === "dark" ? "light" : "dark");
  };

  if (!mounted) {
    return (
      <SidebarMenuButton
        className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
      >
        <Moon className="w-5 h-5 flex-shrink-0" />
        {state === "expanded" && <span>Dark Mode</span>}
      </SidebarMenuButton>
    );
  }

  return (
    <SidebarMenuButton
      tooltip={
        theme === "dark" ? "Switch to Light Mode" : "Switch to Dark Mode"
      }
      onClick={toggleDarkMode}
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      {theme === "dark" ? (
        <Sun className="w-5 h-5 flex-shrink-0" />
      ) : (
        <Moon className="w-5 h-5 flex-shrink-0" />
      )}
      {state === "expanded" && (
        <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>
      )}
    </SidebarMenuButton>
  );
}

function ExpandCollapseButton() {
  const { state, toggleSidebar } = useSidebar();

  return (
    <SidebarMenuButton
      tooltip={state === "collapsed" ? "Expand" : "Collapse"}
      onClick={toggleSidebar}
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      {state === "collapsed" ? (
        <ArrowRightFromLine className="w-5 h-5 flex-shrink-0" />
      ) : (
        <ArrowLeftFromLine className="w-5 h-5 flex-shrink-0" />
      )}
      {state === "expanded" && <span>Collapse</span>}
    </SidebarMenuButton>
  );
}

export default function AppSidebar() {
  return (
    <Sidebar collapsible="icon" className="relative">
      <SidebarHeader>
        <LogoComponent />
        <Separator />
      </SidebarHeader>

      <SidebarContent className="space-y-1">
        <SidebarGroup>
          <SidebarGroupLabel className="text-sm font-medium mb-2">
            Platform
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem className="mb-1">
                <ExploreComponent />
              </SidebarMenuItem>

              <SidebarMenuItem className="mb-1">
                <IntegrateComponent />
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <ExpandCollapseButton />
        <DarkModeToggle />
        <DocumentationComponent />
        <NeedHelpComponent />
        <SettingsComponent />
        <Separator />
        <ProfileComponent />
      </SidebarFooter>
    </Sidebar>
  );
}
