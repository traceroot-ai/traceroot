import { prisma } from "@traceroot/core";
import { createSlackClient, installationStore } from "@traceroot/slack";
import { latestSlotAtOrBefore } from "@traceroot/core/updates";
import { hexId } from "./prng.js";
import { scheduleOf, workspaceIdOf, type Scenario } from "./scenario.js";

export interface PostgresOptions {
  /** Address that receives the update email. */
  inbox?: string;
  /** An existing user, made an admin of the seeded workspace so the data can be seen in the app. */
  memberEmail?: string;
  /** When given, the seeded workspace gets a Slack connection with this bot. */
  slack?: { botToken: string; channelId: string };
}

const WORKSPACE_NAME = "Seeded updates workspace";

/**
 * An already-connected Slack installation for a seeded workspace, stored through the app's own
 * installation store (the bot token is encrypted the way the product does it). The team and bot
 * identity are read from Slack itself, and the channel is set the way the channel route sets it.
 */
export async function connectSlack(
  workspaceId: string,
  slack: { botToken: string; channelId: string },
): Promise<void> {
  const client = createSlackClient(slack.botToken);
  const who = await client.auth.test();
  if (!who.ok || !who.team_id || !who.user_id)
    throw new Error("Slack did not accept the bot token.");
  const channel = await client.conversations.info({ channel: slack.channelId });
  await installationStore.storeInstallation({
    team: { id: who.team_id, name: who.team },
    enterprise: undefined,
    user: { id: "", token: undefined, scopes: undefined },
    bot: { token: slack.botToken, userId: who.user_id, id: who.bot_id ?? "", scopes: [] },
    isEnterpriseInstall: false,
    metadata: JSON.stringify({ workspaceId }),
  } as never);
  await prisma.slackIntegration.update({
    where: { workspaceId },
    data: { channelId: slack.channelId, channelName: channel.channel?.name ?? null },
  });
}

export function seededWorkspaceIds(prefix: string): string[] {
  return [workspaceIdOf(prefix, "a"), workspaceIdOf(prefix, "b")];
}

/** Remove the seeded workspaces; projects, schedules, runs, signals and hits go with them. */
export async function cleanPostgres(prefix: string): Promise<void> {
  // The name is an ownership marker: a real workspace whose id happens to match is left alone.
  await prisma.workspace.deleteMany({
    where: { id: { in: seededWorkspaceIds(prefix) }, name: { startsWith: WORKSPACE_NAME } },
  });
}

export async function countPostgres(prefix: string) {
  const projectIds = (
    await prisma.project.findMany({
      where: { workspaceId: { in: seededWorkspaceIds(prefix) } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const inProjects = { projectId: { in: projectIds } };
  return {
    workspaces: await prisma.workspace.count({ where: { id: { in: seededWorkspaceIds(prefix) } } }),
    projects: projectIds.length,
    schedules: await prisma.projectUpdateSchedule.count({ where: inProjects }),
    runs: await prisma.projectUpdateRun.count({ where: inProjects }),
    detectors: await prisma.detector.count({ where: inProjects }),
    signals: await prisma.signal.count({ where: inProjects }),
    signalHits: await prisma.signalHit.count({ where: inProjects }),
  };
}

export async function writePostgres(
  scenario: Scenario,
  options: PostgresOptions = {},
): Promise<void> {
  const { params } = scenario;
  const schedule = scheduleOf(params);

  for (const which of ["a", "b"] as const) {
    await prisma.workspace.create({
      data: { id: workspaceIdOf(params.prefix, which), name: `${WORKSPACE_NAME} ${which}` },
    });
  }

  if (options.memberEmail) {
    const user = await prisma.user.findUnique({ where: { email: options.memberEmail } });
    if (!user)
      throw new Error(`No user with the email ${options.memberEmail} exists to make a member.`);
    await prisma.workspaceMember.create({
      data: {
        id: `${params.prefix}-member`,
        workspaceId: workspaceIdOf(params.prefix, "a"),
        userId: user.id,
        role: "ADMIN",
      },
    });
  }

  if (options.slack) await connectSlack(workspaceIdOf(params.prefix, "a"), options.slack);

  for (const project of scenario.projects) {
    await prisma.project.create({
      data: {
        id: project.id,
        workspaceId: workspaceIdOf(params.prefix, project.plan.workspace),
        name: project.plan.name,
      },
    });
    await prisma.projectUpdateSchedule.create({
      data: {
        projectId: project.id,
        enabled: true,
        frequency: schedule.frequency,
        weekday: schedule.weekday,
        hour: schedule.hour,
        timezone: schedule.timezone,
        // The slot that has just passed and not yet run: a tick at the seed's "now" starts the seeded window.
        nextSlotAt: latestSlotAtOrBefore(schedule, params.now),
        codeChangesEnabled: project.plan.code?.enabled ?? false,
        codeRepos: project.plan.code?.repos ?? [],
      },
    });
    if (project.plan.workspace === "a" && options.inbox) {
      await prisma.detectorAlertConfig.create({
        data: { projectId: project.id, emailAddresses: [options.inbox] },
      });
    }

    if (project.signals.length === 0) continue;
    const detectorId = `${params.prefix}-det-${project.key}`;
    await prisma.detector.create({
      data: {
        id: detectorId,
        projectId: project.id,
        name: `Seeded detector ${project.key}`,
        template: "blank",
        prompt: "Seeded detector used only to own the seeded signals.",
        outputSchema: {},
        enabled: false,
      },
    });
    for (const signal of project.signals) {
      await prisma.signal.create({
        data: {
          id: signal.id,
          projectId: project.id,
          detectorId,
          title: signal.title,
          criteriaCovers: signal.title,
          criteriaExcludes: "",
          anchorText: signal.title,
          anchorEmbedding: [],
          status: signal.status,
          resolvedAt: signal.resolvedAt,
          hitCount: signal.hitTimes.length,
          firstSeenAt: signal.firstSeenAt,
          lastSeenAt: signal.lastSeenAt,
        },
      });
      await prisma.signalHit.createMany({
        data: signal.hitTimes.map((seenAt, index) => ({
          runId: hexId(`${signal.id}|run|${index}`, 32),
          signalId: signal.id,
          projectId: project.id,
          detectorId,
          traceId: signal.hitTraceIds[index],
          findingId: hexId(`${signal.id}|finding|${index}`, 32),
          seenAt,
          traceStartTime: seenAt,
          embedding: [],
          copyPending: false,
        })),
      });
      if (signal.status === "resolved" && signal.resolvedAt) {
        await prisma.signalStatusEvent.create({
          data: {
            signalId: signal.id,
            actorUserId: "seed",
            fromStatus: "open",
            toStatus: "resolved",
            reason: "fixed",
            createTime: signal.resolvedAt,
          },
        });
      }
    }
  }
}
