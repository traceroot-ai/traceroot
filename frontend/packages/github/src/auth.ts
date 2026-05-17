import { generateJWT } from "./jwt";

function normalizeInstallationId(installationId: string): string {
  const normalized = installationId.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error("Invalid GitHub installation id");
  }
  return normalized;
}

export async function getInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string,
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
      },
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
