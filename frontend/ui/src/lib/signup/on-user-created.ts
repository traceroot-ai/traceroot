// What follows a new account, run from better-auth's user.create.after hook:
// today an internal Slack notice. Never rejects; each arm fails on its own.
import { prisma } from "@traceroot/core";
import { env } from "@/env";
import { findPostHogPerson } from "./posthog-person";
import { notifySignupSlack } from "./notify-slack";

export interface CreatedUser {
  id: string;
  email: string;
  name: string | null;
}

export function isSignupHookEnabled(e: { TRACEROOT_CLOUD: string } = env): boolean {
  return e.TRACEROOT_CLOUD.trim().toLowerCase() === "true";
}

export function signupProvider(path: string | undefined): string {
  if (!path) return "unknown";
  if (path.includes("/sign-up/email")) return "email";
  const social = /\/callback\/([a-z0-9-]+)/i.exec(path);
  return social ? social[1].toLowerCase() : "unknown";
}

async function arm<T>(
  label: string,
  userId: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    console.error(`[signup] ${label} failed for user ${userId}:`, error);
    return undefined;
  }
}

export async function onUserCreated(
  user: CreatedUser,
  context: { path?: string } | null,
): Promise<void> {
  // A user provisioned by staff through the admin plugin is not a sign-up.
  if (!isSignupHookEnabled() || context?.path === "/admin/create-user") return;

  const provider = signupProvider(context?.path);
  const viaInvite =
    (await arm("invite lookup", user.id, () =>
      prisma.invite.findFirst({
        where: { email: { equals: user.email, mode: "insensitive" } },
        select: { id: true },
      }),
    )) != null;

  await arm("slack", user.id, async () => {
    if (!env.TRACEROOT_SIGNUP_SLACK_WEBHOOK_URL?.trim()) return false;
    const [facts, totalUsers] = await Promise.all([
      findPostHogPerson(user.id),
      arm("user count", user.id, () => prisma.user.count()),
    ]);
    return notifySignupSlack({
      name: user.name,
      email: user.email,
      provider,
      viaInvite,
      facts,
      supportConsoleUrl: `${env.NEXT_PUBLIC_APP_URL}/admin`,
      totalUsers,
    });
  });
}
