"use client";

import { useQuery } from "@tanstack/react-query";
import { FaGithub } from "react-icons/fa";
import { fetchGitHubConnection } from "@/lib/github";

interface GitHubStatusProps {
  workspaceId: string;
}

export function GitHubStatus({ workspaceId }: GitHubStatusProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["github-connection", workspaceId],
    queryFn: () => fetchGitHubConnection(workspaceId),
    enabled: !!workspaceId,
  });

  if (isLoading) return null;
  if (!data?.connected) return null;

  const summary =
    data.installations.length === 1
      ? `@${data.installations[0].accountLogin}`
      : `${data.installations.length} installations`;

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <FaGithub className="h-4 w-4" />
      <span>Connected to {summary}</span>
    </div>
  );
}
