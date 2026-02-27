"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FaGithub } from "react-icons/fa";
import { ChevronDown, ExternalLink, Unlink } from "lucide-react";
import { fetchGitHubConnection } from "@/lib/github";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

export function GitHubConnectButton() {
  const queryClient = useQueryClient();
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["github-connection"],
    queryFn: fetchGitHubConnection,
  });

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      const res = await fetch("/api/github/disconnect", { method: "POST" });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["github-connection"] });
        setOpen(false);
      }
    } finally {
      setIsDisconnecting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FaGithub className="h-6 w-6 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">GitHub</div>
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        </div>
      </div>
    );
  }

  if (data?.connected) {
    return (
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FaGithub className="h-6 w-6" />
          <div>
            <div className="text-sm font-medium">GitHub</div>
            <div className="text-sm text-muted-foreground">
              Connect GitHub for repository linking and code-level tracing.
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              Connected as <span className="font-medium text-foreground">{data.username}</span>
            </div>
          </div>
        </div>

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1">
              Manage
              <ChevronDown className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48 p-1">
            <a
              href={`/api/github/install?returnTo=${encodeURIComponent(window.location.pathname)}`}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <ExternalLink className="h-4 w-4" />
              Configure
            </a>
            <button
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-accent disabled:opacity-50"
            >
              <Unlink className="h-4 w-4" />
              {isDisconnecting ? "Disconnecting..." : "Disconnect"}
            </button>
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <FaGithub className="h-6 w-6 text-muted-foreground" />
        <div>
          <div className="text-sm font-medium">GitHub</div>
          <div className="text-sm text-muted-foreground">
            Connect GitHub for repository linking and code-level tracing.
          </div>
        </div>
      </div>

      <a
        href={`/api/github/login?returnTo=${encodeURIComponent(window.location.pathname)}`}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        Connect
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
