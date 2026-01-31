import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function getMembership(userId: string, orgId: string) {
  return prisma.organizationMembership.findUnique({
    where: { org_id_user_id: { org_id: orgId, user_id: userId } },
  });
}

// GET /api/organizations/[orgId]/members
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

  const memberships = await prisma.organizationMembership.findMany({
    where: { org_id: orgId },
    include: {
      user: {
        select: { id: true, email: true, name: true, image: true },
      },
    },
    orderBy: { created_at: "asc" },
  });

  const members = memberships.map((m) => ({
    id: m.id,
    user_id: m.user_id,
    email: m.user.email,
    name: m.user.name,
    image: m.user.image,
    role: m.role,
    created_at: m.created_at,
  }));

  return NextResponse.json({ data: members });
}
