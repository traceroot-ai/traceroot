"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Telescope, LibraryBig, Settings, ArrowRightFromLine, ArrowLeftFromLine, Mail, BookText } from "lucide-react";
import { FaUser } from 'react-icons/fa';
import { RxCross1 } from 'react-icons/rx';

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
import { useUser } from '../../hooks/useUser';


function LogoComponent() {
  const { state } = useSidebar();

  return (
    <div className={`flex items-center rounded-md m-2 hover:bg-sidebar-accent transition-colors ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}>
      <Link href="/" className={`flex items-center group ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-11.5 w-11.5 flex-shrink-0"
          viewBox="0 0 32 32"
          fill="none"
          stroke="#0a0a0a"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* <rect x="0" y="0" width="32" height="32" rx="8" ry="8" fill="#e5e5e5" stroke="none"/> */}
          <circle cx="16" cy="8" r="2.5"></circle>
          <circle cx="10" cy="16" r="2.5"></circle>
          <circle cx="22" cy="16" r="2.5"></circle>
          <line x1="16" y1="10.5" x2="16" y2="12.5"></line>
          <line x1="16" y1="12.5" x2="12" y2="14.5"></line>
          <line x1="16" y1="12.5" x2="20" y2="14.5"></line>
          <line x1="10" y1="18.5" x2="10" y2="21.5"></line>
          <line x1="22" y1="18.5" x2="22" y2="21.5"></line>
          <circle cx="10" cy="24" r="2.5"></circle>
          <circle cx="22" cy="24" r="2.5"></circle>
        </svg>
        {state === "expanded" && (
          <div className="flex flex-col">
            <span className="font-semibold text-sm">TraceRoot.AI</span>
            <span className="font-semibold text-sm text-[#fb923c]">YCombinator</span>
          </div>
        )}
      </Link>
    </div>
  );
}

function ExploreComponent() {
  const { state } = useSidebar();
  const pathname = usePathname();

  return (
    <SidebarMenuButton
      asChild
      isActive={pathname === '/explore'}
      tooltip="Exploration"
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      <Link href="/explore" className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}>
        <Telescope className="!w-6 !h-6" />
        {state === "expanded" && <span>Explore</span>}
      </Link>
    </SidebarMenuButton>
  );
}

function IntegrateComponent() {
  const { state } = useSidebar();
  const pathname = usePathname();
  return (
    <SidebarMenuButton
      asChild
      isActive={pathname === '/integrate'}
      tooltip="Integration"
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      <Link href="/integrate" className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}>
        <LibraryBig className="!w-6 !h-6" />
        {state === "expanded" && <span>Integrate</span>}
      </Link>
    </SidebarMenuButton>
  );
}

function ContactComponent() {
  const { state } = useSidebar();

  return (
    <SidebarMenuButton
      asChild
      isActive={false}
      tooltip="Contact"
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      <a
        href="https://traceroot.ai" target="_blank" rel="noopener noreferrer"
        className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}
      >
        <Mail className="!w-6 !h-6" />
        {state === "expanded" && <span>Contact</span>}
      </a>
    </SidebarMenuButton>
  );
}

function DocumentationComponent() {
  const { state } = useSidebar();
  return (
    <SidebarMenuButton
      asChild
      isActive={false}
      tooltip="Docs"
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      <a
        href="https://docs.traceroot.ai" target="_blank" rel="noopener noreferrer"
        className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-2"}`}
      >
        <BookText className="!w-6 !h-6" />
        {state === "expanded" && <span>Docs</span>}
      </a>
    </SidebarMenuButton>
  );
}

function SettingsComponent() {
  const { state } = useSidebar();
  const pathname = usePathname();

  return (
    <SidebarMenuButton
      asChild
      isActive={pathname === '/settings'}
      tooltip="Settings"
      className={`flex items-center rounded-md p-2 mb-1 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-1"}`}
    >
      <Link href="/settings" className={`flex items-center w-full ${state === "collapsed" ? "justify-center" : "justify-start gap-1"}`}>
        <Settings className="!w-6 !h-6" />
        {state === "expanded" && <span>Settings</span>}
      </Link>
    </SidebarMenuButton>
  );
}

function ProfileComponent() {
  const { user, avatarLetter, isLoading, logout } = useUser();
  console.log(user);
  const { state } = useSidebar();

  const handleSignOut = () => {
    logout();
    window.location.href = 'https://auth.traceroot.ai/';
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
            key={`avatar-${avatarLetter || 'no-letter'}`}
            className="w-8 h-8 rounded-md bg-sidebar-accent/50 flex items-center justify-center"
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
              <FaUser
                className="text-sidebar-foreground"
                size={14}
              />
            )}
          </div>
          {state === "expanded" && (
            <div className="flex flex-col flex-1 min-w-0 text-left">
              <span className="text-xs font-medium truncate">
                {user?.given_name || user?.email?.split('@')[0] || 'First Name'}
              </span>
              <span className="text-xs truncate">
                {user?.family_name || 'Last Name'}
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
              {user?.given_name ? `Hello ${user.given_name}!` : user?.email ? `Hello ${user.email}!` : 'Welcome!'}
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
                  value={user.email || ''}
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
                    value={user.given_name || ''}
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
                    value={user.family_name || ''}
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
                    value={user.company || ''}
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
                  href="https://traceroot.ai"
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
                <Button
                  onClick={handleSignOut}
                  variant="destructive"
                >
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

function ExpandCollapseButton() {
  const { state, toggleSidebar } = useSidebar();

  return (
    <SidebarMenuButton
      tooltip={state === "collapsed" ? "Expand" : "Collapse"}
      onClick={toggleSidebar}
      className={`flex items-center rounded-md p-2 mb-2 ${state === "collapsed" ? "!justify-center" : "!justify-start gap-2"}`}
    >
      {state === "collapsed" ? (
        <ArrowRightFromLine className="!w-5.5 !h-5.5" />
      ) : (
        <ArrowLeftFromLine className="!w-5.5 !h-5.5" />
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
          <SidebarGroupLabel className="text-sm font-medium mb-2">Platform</SidebarGroupLabel>
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
        <SettingsComponent />
        <Separator />
        <ProfileComponent />
      </SidebarFooter>
    </Sidebar>
  );
}
