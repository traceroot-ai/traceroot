import { prisma } from "@traceroot/core";

// The project a user picked for the OAuth authorization in progress. better-auth
// ties a consent to one "reference" and asks us for it at two points (whether the
// user still has to choose, and which project the consent is for), neither of
// which sees the request, only the session. So the choice is parked against the
// session in the verification table, which already expires its rows, and read
// back from there. It is not a credential: the project is re-checked against the
// user's membership when it is chosen and again on every request the resulting
// token makes.

const PREFIX = "oauth-project:";
export const PROJECT_SELECTION_TTL_MS = 10 * 60 * 1000;

function identifier(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export async function saveProjectSelection(sessionId: string, projectId: string): Promise<void> {
  await prisma.$transaction([
    prisma.verification.deleteMany({ where: { identifier: identifier(sessionId) } }),
    prisma.verification.create({
      data: {
        identifier: identifier(sessionId),
        value: projectId,
        expiresAt: new Date(Date.now() + PROJECT_SELECTION_TTL_MS),
      },
    }),
  ]);
}

export async function readProjectSelection(sessionId: string): Promise<string | null> {
  const row = await prisma.verification.findFirst({
    where: { identifier: identifier(sessionId), expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { value: true },
  });
  return row?.value ?? null;
}

export async function clearProjectSelection(sessionId: string): Promise<void> {
  await prisma.verification.deleteMany({ where: { identifier: identifier(sessionId) } });
}
