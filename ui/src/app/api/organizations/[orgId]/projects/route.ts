import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

async function getMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// GET /api/organizations/[orgId]/projects
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;
  const membership = await getMembership(session.user.id, orgId);
  if (!membership) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const projects = await prisma.project.findMany({
    where: { org_id: orgId, deleted_at: null },
    orderBy: { created_at: "desc" },
  });

  return NextResponse.json({ data: projects });
}

// POST /api/organizations/[orgId]/projects
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { orgId } = await params;
  const membership = await getMembership(session.user.id, orgId);
  if (!membership || !["OWNER", "ADMIN", "MEMBER"].includes(membership.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { name } = await request.json();
  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: {
      id: randomUUID(),
      org_id: orgId,
      name: name.trim(),
    },
  });

  return NextResponse.json(project);
}
