"use client";

import { useQuery } from "@tanstack/react-query";
import { FaGithub } from "react-icons/fa";
import { fetchGitHubConnection } from "@/lib/github";

export function GitHubStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ["github-connection"],
    queryFn: fetchGitHubConnection,
  });

  if (isLoading) return null;
  if (!data?.connected) return null;

  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <FaGithub className="h-4 w-4" />
      <span>Connected as @{data.username}</span>
      {data.installationId && <span className="text-green-600">&#8226; App installed</span>}
    </div>
  );
}
