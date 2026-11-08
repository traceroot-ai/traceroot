import { complete } from "@earendil-works/pi-ai/compat";
import { decryptKey, hasEntitlement, prisma, type PlanType } from "@traceroot/core";
import { createSlackClient } from "@traceroot/slack";
import { resolveRecipients } from "../notifications/digest-recipients.js";
import { sendEmail } from "../notifications/email.js";
import {
  aggregatesConfigFromEnv,
  readTraceSample,
  runBoundedSql,
  type AggregatesClientConfig,
} from "./aggregates-client.js";
import type { SlackPoster } from "./deliver.js";
import type { CodeChangesDeps } from "./code/code-changes.js";
import { DEFAULT_REPO_LIMITS } from "./code/repo-reader.js";
import {
  DaytonaSandboxProvider,
  DockerSandboxProvider,
  type SandboxProvider,
} from "./code/sandbox.js";
import { internalTokenProvider } from "./code/token.js";
import { resolveUpdateModel } from "./model.js";
import type { AgentStageDeps } from "./stage.js";

/** A Slack poster for a workspace's bot, or null when its plan has no Slack integration. */
async function slackPosterFor(
  workspaceId: string,
  encryptedBotToken: string,
): Promise<SlackPoster | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { billingPlan: true },
  });
  const plan = (workspace?.billingPlan ?? "free") as PlanType;
  if (!hasEntitlement(plan, "slack-integration")) return null;
  const client = createSlackClient(decryptKey(encryptedBotToken));
  return {
    async postHeadline(channelId, post) {
      const res = await client.chat.postMessage({
        channel: channelId,
        text: post.text,
        blocks: post.blocks as never,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ok || !res.ts)
        throw new Error(`Slack did not accept the message: ${res.error ?? "no timestamp"}`);
      return res.ts;
    },
    async postInThread(channelId, threadTs, post) {
      const res = await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: post.text,
        blocks: post.blocks as never,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!res.ok)
        throw new Error(`Slack did not accept the thread message: ${res.error ?? "unknown"}`);
    },
  };
}

/**
 * Development only: make the first email of each run fail, to watch a retry
 * resume without a second model call or a second message. Off unless
 * UPDATES_INJECT_FAULT=email-once, and never in production.
 */
/** Messages that have already failed once, kept for the life of the process so a retry gets through. */
const failedOnce = new Set<string>();

function faultyEmail(send: typeof sendEmail): typeof sendEmail {
  if (process.env.UPDATES_INJECT_FAULT !== "email-once" || process.env.NODE_ENV === "production") {
    return send;
  }
  return async (mail) => {
    const key = `${mail.to.join(",")}|${mail.subject}`;
    if (!failedOnce.has(key)) {
      failedOnce.add(key);
      throw new Error(
        "injected fault: the mail transport failed (UPDATES_INJECT_FAULT=email-once)",
      );
    }
    return send(mail);
  };
}

/**
 * The sandbox provider for the code changes section: Daytona when it has a key
 * (the production arrangement), Docker where asked for (development), otherwise
 * none, in which case the section runs on the host's metadata alone and says so.
 */
export async function sandboxProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SandboxProvider | null> {
  const wanted = (env.UPDATE_SANDBOX ?? (env.DAYTONA_API_KEY ? "daytona" : "none")).toLowerCase();
  if (wanted === "docker") {
    return new DockerSandboxProvider({
      cloneNetwork: env.UPDATE_SANDBOX_CLONE_NETWORK === "host" ? "host" : "bridge",
      limits: env.UPDATE_SANDBOX_LIMITS === "none" ? {} : undefined,
    });
  }
  if (wanted === "daytona" && env.DAYTONA_API_KEY) {
    const { Daytona } = await import("@daytonaio/sdk");
    const daytona = new Daytona({
      apiKey: env.DAYTONA_API_KEY,
      apiUrl: "https://app.daytona.io/api",
      target: "us",
    });
    return new DaytonaSandboxProvider(daytona as never);
  }
  return null;
}

export function codeChangesDepsFromEnv(
  provider: SandboxProvider | null,
  env: NodeJS.ProcessEnv = process.env,
): CodeChangesDeps {
  const stubToken = env.UPDATE_GITHUB_STUB_TOKEN;
  return {
    provider,
    github: { baseUrl: env.UPDATE_GITHUB_API_BASE_URL || "https://api.github.com" },
    log: (line) => console.log(`[Updates] code ${line}`),
    // A stand-in API issues its own token; the real path asks the app for an installation token.
    tokenFor: stubToken
      ? async () => stubToken
      : internalTokenProvider({
          appBaseUrl: env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
          internalSecret: env.INTERNAL_API_SECRET || "",
        }),
    limits: {
      cloneTimeoutSec:
        Number(env.UPDATE_CLONE_TIMEOUT_SECONDS) || DEFAULT_REPO_LIMITS.cloneTimeoutSec,
      maxRepoBytes:
        (Number(env.UPDATE_CLONE_MAX_MB) || DEFAULT_REPO_LIMITS.maxRepoBytes / 1048576) * 1048576,
      maxArchiveBytes: DEFAULT_REPO_LIMITS.maxArchiveBytes,
    },
  };
}

/** The agent, its tools and delivery wired to the real services. */
export function buildAgentStageDeps(
  config: AggregatesClientConfig = aggregatesConfigFromEnv(),
  sandbox: SandboxProvider | null = null,
): AgentStageDeps {
  return {
    codeChanges: codeChangesDepsFromEnv(sandbox),
    resolveModel: (project) => resolveUpdateModel(project),
    complete: complete as AgentStageDeps["complete"],
    log: process.env.UPDATE_AGENT_DEBUG
      ? (line) => console.log(`[Updates] agent ${line}`)
      : undefined,
    readSample: (projectId, run, seed) =>
      readTraceSample(config, projectId, run.windowStart, run.windowEnd, seed),
    runSql: (projectId, query) => runBoundedSql(config, projectId, query),
    delivery: {
      db: prisma,
      resolveRecipients: async (projectId) => {
        const r = await resolveRecipients(projectId);
        return r
          ? {
              workspaceId: r.workspaceId,
              slackChannelId: r.slackChannelId,
              encryptedBotToken: r.encryptedBotToken,
              emailAddresses: r.emailAddresses,
            }
          : null;
      },
      slackFor: slackPosterFor,
      sendEmail: faultyEmail(sendEmail),
    },
  };
}
