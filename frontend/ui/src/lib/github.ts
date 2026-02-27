"use client";

export interface GitHubConnectionStatus {
  connected: boolean;
  username?: string;
  installationId?: string; // Present when connected is true
}

export async function fetchGitHubConnection(): Promise<GitHubConnectionStatus> {
  const res = await fetch("/api/github/status");
  if (!res.ok) return { connected: false };
  return res.json();
}
