import { createHash, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/env";
import { PAUSE_REASONS, setFollowUpPause } from "@/lib/lifecycle/pause";

const bodySchema = z
  .object({
    userId: z.string().min(1).max(100),
    action: z.enum(["pause", "resume"]),
    reason: z.enum(PAUSE_REASONS).optional(),
  })
  .strict();

function authorized(request: NextRequest): boolean {
  const expected = env.LIFECYCLE_PAUSE_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!expected || !provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

// POST /api/internal/follow-ups/pause
// Pauses or resumes one person's follow-up emails; the lead service calls it when
// outreach starts, when someone presses Pause or Resume on a lead card, and when
// the person posts in their shared channel. Answers where the person now stands,
// including an unsubscribe, which resuming does not clear. Repeating a call
// changes nothing. Its own secret (LIFECYCLE_PAUSE_SECRET), as a bearer token.
export async function POST(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { userId, action, reason } = parsed.data;
  const hold = await setFollowUpPause(userId, action, reason);
  if (!hold) return NextResponse.json({ error: "Unknown user" }, { status: 404 });
  console.log(
    `[follow-ups] ${action} for user ${userId}${action === "pause" ? ` (${reason ?? "manual"})` : ""}`,
  );
  return NextResponse.json({ userId, ...hold });
}
