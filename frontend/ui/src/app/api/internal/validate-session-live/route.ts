import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  sessionId: z.string("sessionId is required").min(1, "sessionId is required"),
});

// POST /api/internal/validate-session-live — liveness check for a session id.
// The backend's write path calls this with the sid from an already-verified
// JWT, so revoking the session takes effect immediately on writes even while
// the offline-verified JWT is still within its lifetime. The result is a
// discriminated 200 either way: { live: true } only when the session row still
// exists and has not expired. Never log ids.
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
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const session = await prisma.session.findUnique({
    where: { id: parsed.data.sessionId },
    select: { expiresAt: true },
  });
  const live = session !== null && session.expiresAt.getTime() > Date.now();
  return NextResponse.json({ live });
}
