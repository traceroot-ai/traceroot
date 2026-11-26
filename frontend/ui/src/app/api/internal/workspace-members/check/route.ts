import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { isLeadServiceRequest } from "@/lib/lead-service-auth";

const bodySchema = z
  .object({
    userId: z.string().min(1).max(100),
    workspaceId: z.string().min(1).max(100),
  })
  .strict();

// POST /api/internal/workspace-members/check
// Whether one person is a member of one workspace right now. The lead service
// asks just before it invites someone to that workspace's Slack channel, since
// the membership it was told about earlier may have been removed since. Reads
// only, from the membership table itself. A failed read answers 500, never "not
// a member", so the caller can tell it apart and try again later. The lead
// service's own secret, as a bearer token (lib/lead-service-auth.ts).
export async function POST(request: NextRequest) {
  if (!isLeadServiceRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { userId, workspaceId } = parsed.data;
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  });
  return NextResponse.json({
    userId,
    workspaceId,
    member: membership !== null,
    role: membership?.role ?? null,
  });
}
