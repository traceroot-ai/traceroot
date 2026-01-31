"use client";

import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { Mail, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

async function getInvitationsCount() {
  const res = await fetch("/api/invitations");
  if (!res.ok) return 0;
  const data = await res.json();
  return data.data?.length || 0;
}

export function Header() {
  const { data: session, status } = useSession();

  const { data: invitationsCount } = useQuery({
    queryKey: ["myInvitationsCount"],
    queryFn: getInvitationsCount,
    enabled: status === "authenticated",
    refetchInterval: 60000,
  });

  if (status !== "authenticated") {
    return null;
  }

  return (
    <header className="flex h-14 items-center justify-end border-b bg-white px-6">
      <div className="flex items-center gap-4">
        {/* Invitations */}
        <Link
          href="/invitations"
          className="relative rounded-md p-2 text-muted-foreground hover:bg-gray-100 hover:text-foreground"
        >
          <Mail className="h-5 w-5" />
          {invitationsCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-xs font-medium text-white">
              {invitationsCount}
            </span>
          )}
        </Link>

        {/* User email */}
        <span className="text-sm text-muted-foreground">
          {session?.user?.email}
        </span>

        {/* Sign out */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => signOut({ callbackUrl: "/auth/sign-in" })}
          className="text-muted-foreground"
        >
          <LogOut className="mr-2 h-4 w-4" />
          Sign out
        </Button>
      </div>
    </header>
  );
}
