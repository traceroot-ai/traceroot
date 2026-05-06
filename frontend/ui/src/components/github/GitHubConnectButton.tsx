"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import { FaGithub } from "react-icons/fa";
import { ChevronDown, ExternalLink, Unlink } from "lucide-react";
import { fetchGitHubConnection } from "@/lib/github";
import { useWorkspace } from "@/features/workspaces/hooks";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";

interface GitHubConnectButtonProps {
  workspaceId: string;
}

export function GitHubConnectButton({ workspaceId }: GitHubConnectButtonProps) {
  const queryClient = useQueryClient();
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [open, setOpen] = useState(false);

  const { data: workspace } = useWorkspace(workspaceId);
  const canManage = workspace?.role === "ADMIN";
  const pathname = usePathname();

  const { data, isLoading } = useQuery({
    queryKey: ["github-connection", workspaceId],
    queryFn: () => fetchGitHubConnection(workspaceId),
    enabled: !!workspaceId,
  });

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      const res = await fetch(
        `/api/github/disconnect?workspaceId=${encodeURIComponent(workspaceId)}`,
        { method: "POST" },
      );
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ["github-connection", workspaceId] });
        setOpen(false);
      }
    } finally {
      setIsDisconnecting(false);
    }
  };

  // usePathname is consistent on server and client — using window.location here
  // would create an SSR/CSR hydration mismatch in this client component.
  const buildHref = (path: string) =>
    `${path}?workspaceId=${encodeURIComponent(workspaceId)}&returnTo=${encodeURIComponent(pathname || "/")}`;

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
    const summary =
      data.installations.length === 1
        ? data.installations[0].accountLogin
        : `${data.installations.length} installations`;
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
              Connected to <span className="font-medium text-foreground">{summary}</span>
            </div>
          </div>
        </div>

        {canManage && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1">
                Manage
                <ChevronDown className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-1">
              <a
                href={buildHref("/api/github/install")}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[12px] transition-colors hover:bg-accent"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Configure
              </a>
              <button
                onClick={handleDisconnect}
                disabled={isDisconnecting}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-[12px] text-destructive transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Unlink className="h-3.5 w-3.5" />
                {isDisconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
            </PopoverContent>
          </Popover>
        )}
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
            {canManage
              ? "Connect GitHub for repository linking and code-level tracing."
              : "GitHub is not connected. Ask a workspace admin to set it up."}
          </div>
        </div>
      </div>

      {canManage && (
        <a
          href={buildHref("/api/github/login")}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Connect
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}
