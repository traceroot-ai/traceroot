"use client";

import Link from "next/link";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { FaSlack } from "react-icons/fa";
import { cn } from "@/lib/utils";

interface SlackIntegrationLinkProps {
  href: string;
  isConnected: boolean;
  teamName?: string;
  channelName?: string;
  className?: string;
}

/**
 * The row linking to the workspace's Slack integration. Shared by the alerts
 * onboarding splash and the alert form so the two read the same connection the
 * same way.
 */
export function SlackIntegrationLink({
  href,
  isConnected,
  teamName,
  channelName,
  className,
}: SlackIntegrationLinkProps) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[12px] transition-colors hover:bg-muted/50",
        className,
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <FaSlack className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        {isConnected ? (
          <span className="min-w-0 truncate">
            Connected to <span className="font-medium">{teamName}</span>
            {channelName ? (
              <span className="text-muted-foreground"> · #{channelName}</span>
            ) : (
              <span className="text-muted-foreground"> · No channel selected</span>
            )}
          </span>
        ) : (
          <span>Connect Slack</span>
        )}
      </span>
      {isConnected ? (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          Manage
          <ArrowUpRight className="h-3 w-3" />
        </span>
      ) : (
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
    </Link>
  );
}
