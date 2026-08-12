import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { auth } from "@/lib/auth";

const userMembershipsSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

// POST /api/internal/user-memberships
// Internal endpoint for the Python backend to resolve a user's account-scope
// workspace/project graph (the CLI login `list_workspaces` / `list_projects`).
// One query returns everything (no N+1). Never log the token.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = userMembershipsSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }

  const { token } = result.data;

  // Resolve the session via the bearer plugin, which accepts the session token as an
  // Authorization header in place of the cookie. Never log the token or these headers.
  let session: Awaited<ReturnType<typeof auth.api.getSession>>;
  try {
    session = await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${token}` }),
    });
  } catch {
    session = null;
  }

  if (!session?.user?.id) {
    return NextResponse.json({ error: "invalid or expired token" }, { status: 401 });
  }

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId: session.user.id },
    include: {
      workspace: {
        include: {
          projects: {
            where: { deleteTime: null },
            select: { id: true, name: true },
          },
        },
      },
    },
    orderBy: { workspace: { name: "asc" } },
  });

  const workspaces = memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    role: m.role,
    projects: m.workspace.projects,
  }));

  return NextResponse.json({ workspaces });
}
