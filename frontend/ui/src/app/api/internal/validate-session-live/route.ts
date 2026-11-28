import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  sessionId: z.string("sessionId is required").min(1, "sessionId is required"),
  userId: z.string().min(1).optional(),
});

// POST /api/internal/validate-session-live — liveness check for a session id.
// The backend checks every verified JWT's sid here, so revocation applies to
// reads and writes before the token expires. Optional userId binds the session
// to its verified subject while supporting older backend callers. The result is a
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
    select: { expiresAt: true, impersonatedBy: true, userId: true },
  });
  const live =
    session !== null &&
    !session.impersonatedBy &&
    (parsed.data.userId === undefined || session.userId === parsed.data.userId) &&
    session.expiresAt.getTime() > Date.now();
  return NextResponse.json({ live });
}
