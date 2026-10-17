import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const userMembershipsSchema = z.object({
  userId: z.string().min(1, "userId is required"),
});

// POST /api/internal/user-memberships
//
// Resolves a user's account-scope workspace/project graph (the CLI login
// `list_workspaces` / `list_projects`), given a userId the caller has ALREADY
// authenticated. Used by the Python backend for BOTH account-scope credentials:
// a raw session token (introspected via validate-user-token) and a CLI access
// JWT (verified offline against the JWKS). Either way the backend establishes
// identity first and forwards the resolved userId — like user-project-access,
// this does NOT re-validate a session token; trust is the X-Internal-Secret plus
// the backend's verified identity. One query returns everything (no N+1). Never
// log ids.
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

  const { userId } = result.data;

  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
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
