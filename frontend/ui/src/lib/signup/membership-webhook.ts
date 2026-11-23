// Reports a new workspace membership on the sign-up webhook, so the receiver
// can tell which sign-ups belong to the same traceroot workspace. Same URL,
// secret and signature as user_signed_up; nothing is sent unless both are set.
// It carries ids only. Never throws: a membership change never waits on it or
// fails because of it. A failed delivery is tried twice more, then logged with
// the ids only.
import {
  sendSignupWebhook,
  type SendSignupWebhookOptions,
  type WorkspaceMemberEvent,
} from "./signup-webhook";

const ATTEMPTS = 3;
const RETRY_DELAY_MS = 2_000;

export interface WorkspaceMemberInput {
  userId: string;
  workspaceId: string;
  createdBy?: string | null;
  via: WorkspaceMemberEvent["via"];
  occurredAt?: Date;
}

export function buildWorkspaceMemberEvent(input: WorkspaceMemberInput): WorkspaceMemberEvent {
  return {
    event: "workspace_member_joined",
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    user: { id: input.userId },
    workspace: { id: input.workspaceId, created_by: input.createdBy ?? null },
    via: input.via,
  };
}

export async function notifyWorkspaceMember(
  input: WorkspaceMemberInput,
  options: SendSignupWebhookOptions & { retryDelayMs?: number } = {},
): Promise<boolean> {
  const event = buildWorkspaceMemberEvent(input);
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      // false: not configured, so there is nothing to retry.
      return await sendSignupWebhook(event, options);
    } catch (error) {
      if (attempt === ATTEMPTS) {
        console.error(
          `[signup] membership webhook failed for user ${input.userId} in workspace ${input.workspaceId}:`,
          error instanceof Error ? error.message : error,
        );
        return false;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, (options.retryDelayMs ?? RETRY_DELAY_MS) * attempt),
      );
    }
  }
  return false;
}
