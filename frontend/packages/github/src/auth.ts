import { generateJWT } from "./jwt";

function normalizeInstallationId(installationId: string): string {
  const normalized = installationId.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("Invalid GitHub installation id");
  }
  return normalized;
}

export interface InstallationTokenScope {
  /** Repository names (without owner) the token may access. Omit for every repository of the installation. */
  repositories?: string[];
  /** Permission name to access level. Omit for every permission the installation grants. */
  permissions?: Record<string, "read" | "write">;
}

export async function getInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string,
  scope?: InstallationTokenScope,
): Promise<{ token: string; expires_at: string }> {
  const safeInstallationId = normalizeInstallationId(installationId);
  const jwtToken = generateJWT(appId, privateKey.replace(/\\n/g, "\n"));

  const res = await fetch(
    `https://api.github.com/app/installations/${safeInstallationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "TraceRoot",
        ...(scope ? { "Content-Type": "application/json" } : {}),
      },
      ...(scope ? { body: JSON.stringify(scope) } : {}),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error: ${res.status} ${body}`);
  }
  return res.json();
}

export interface GitHubInstallation {
  id: number;
  account: { login: string; id: number; type: string };
  app_id: number;
}

export async function getInstallation(
  installationId: string,
  appId: string,
  privateKey: string,
): Promise<GitHubInstallation> {
  const safeInstallationId = normalizeInstallationId(installationId);
  const jwtToken = generateJWT(appId, privateKey.replace(/\\n/g, "\n"));

  const res = await fetch(`https://api.github.com/app/installations/${safeInstallationId}`, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "TraceRoot",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API error: ${res.status} ${body}`);
  }
  return res.json();
}
