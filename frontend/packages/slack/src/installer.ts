import { InstallProvider, type Installation, type InstallationStore } from "@slack/oauth";
import { decryptKey, encryptKey, prisma } from "@traceroot/core";

interface InstallMetadata {
  workspaceId: string;
  connectedByUserId?: string;
  returnTo?: string;
}

function parseMetadata(raw: string | undefined): InstallMetadata {
  if (!raw) throw new Error("Slack install metadata missing");
  return JSON.parse(raw) as InstallMetadata;
}

export const installationStore: InstallationStore = {
  storeInstallation: async (installation: Installation) => {
    const meta = parseMetadata(installation.metadata);
    const teamId = installation.team!.id;
    const teamName = installation.team!.name ?? teamId;
    const botUserId = installation.bot!.userId;
    const botToken = encryptKey(installation.bot!.token);

    await prisma.slackIntegration.upsert({
      where: { workspaceId: meta.workspaceId },
      create: {
        workspaceId: meta.workspaceId,
        teamId,
        teamName,
        botUserId,
        botToken,
        connectedByUserId: meta.connectedByUserId ?? null,
      },
      update: { teamId, teamName, botUserId, botToken },
    });
  },

  fetchInstallation: async (query) => {
    const row = await prisma.slackIntegration.findFirst({
      where: { teamId: query.teamId! },
    });
    if (!row) throw new Error("Slack integration not found");
    return {
      team: { id: row.teamId, name: row.teamName },
      bot: {
        token: decryptKey(row.botToken),
        userId: row.botUserId,
        scopes: [],
        id: "",
      },
      enterprise: undefined,
      user: { token: undefined, id: "", scopes: undefined },
    } as unknown as Installation;
  },

  deleteInstallation: async (query) => {
    await prisma.slackIntegration.deleteMany({ where: { teamId: query.teamId! } });
  },
};

export const installer = new InstallProvider({
  clientId: process.env.SLACK_CLIENT_ID ?? "",
  clientSecret: process.env.SLACK_CLIENT_SECRET ?? "",
  stateSecret: process.env.SLACK_STATE_SECRET ?? "",
  installationStore,
});
