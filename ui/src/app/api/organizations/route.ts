import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";

// GET /api/organizations - List user's organizations
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberships = await prisma.organizationMembership.findMany({
    where: { user_id: session.user.id },
    include: {
      organization: true,
    },
  });

  const organizations = memberships.map((m) => ({
    id: m.organization.id,
    name: m.organization.name,
    role: m.role,
    created_at: m.organization.created_at,
    updated_at: m.organization.updated_at,
  }));

  return NextResponse.json({ data: organizations });
}

// POST /api/organizations - Create organization
export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { name } = await request.json();
  if (!name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const orgId = randomUUID();
  const membershipId = randomUUID();

  const organization = await prisma.organization.create({
    data: {
      id: orgId,
      name: name.trim(),
      organizationMemberships: {
        create: {
          id: membershipId,
          user_id: session.user.id,
          role: "OWNER",
        },
      },
    },
  });

  return NextResponse.json({
    id: organization.id,
    name: organization.name,
    role: "OWNER",
    created_at: organization.created_at,
    updated_at: organization.updated_at,
  });
}
