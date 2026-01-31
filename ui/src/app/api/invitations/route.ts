import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/invitations - get my pending invitations
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const invitations = await prisma.membershipInvitation.findMany({
    where: { email: session.user.email.toLowerCase() },
    include: {
      organization: { select: { id: true, name: true } },
    },
  });

  return NextResponse.json({ data: invitations });
}
