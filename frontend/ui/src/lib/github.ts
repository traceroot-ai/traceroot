"use client";

export interface GitHubInstallation {
  installationId: string;
  accountLogin: string;
}

export interface GitHubConnectionStatus {
  connected: boolean;
  installations: GitHubInstallation[];
}

export async function fetchGitHubConnection(workspaceId: string): Promise<GitHubConnectionStatus> {
  if (!workspaceId) return { connected: false, installations: [] };
  const res = await fetch(`/api/github/status?workspaceId=${encodeURIComponent(workspaceId)}`);
  if (!res.ok) return { connected: false, installations: [] };
  return res.json();
}
