import { prisma, ModelSource, Role, hasMinRole } from "@traceroot/core";
import { env } from "@/env";
import { isDemoWorkspace } from "@/lib/demo-workspace";

/** The model fields of a chat request that the demo policy may replace. */
export interface ChatModelChoice {
  model?: string;
  providerName?: string;
  source?: string;
}

export type DemoChatDecision =
  | { kind: "unrestricted" }
  | { kind: "limited"; choice: ChatModelChoice; remaining: number }
  | { kind: "blocked"; status: 429; error: string };

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Decide how a chat message may run. Visitors in the demo workspace (members
 * below MEMBER) get a daily message limit and one system model; everyone else
 * is unrestricted. The count is checked before the message is sent, so two
 * messages sent at the same moment can pass the last free slot together.
 */
export async function decideDemoChat(params: {
  workspaceId: string;
  userId: string;
  role: Role;
  now?: Date;
}): Promise<DemoChatDecision> {
  const { workspaceId, userId, role } = params;
  if (!isDemoWorkspace(workspaceId) || hasMinRole(role, Role.MEMBER)) {
    return { kind: "unrestricted" };
  }

  const limit = env.DEMO_AI_DAILY_MESSAGE_LIMIT;
  const sent = await prisma.aIMessage.count({
    where: {
      workspaceId,
      role: "user",
      createTime: { gte: startOfUtcDay(params.now ?? new Date()) },
      OR: [
        { kind: "chat", session: { userId } },
        { kind: "rca", metadata: { path: ["initiatorUserId"], equals: userId } },
      ],
    },
  });
  if (sent >= limit) {
    return {
      kind: "blocked",
      status: 429,
      error:
        `The demo allows ${limit} AI messages per day. Try again tomorrow, ` +
        "or create your own workspace to use the AI agent without this limit.",
    };
  }
  return {
    kind: "limited",
    choice: { model: env.DEMO_AI_MODEL, providerName: undefined, source: ModelSource.SYSTEM },
    remaining: limit - sent,
  };
}
