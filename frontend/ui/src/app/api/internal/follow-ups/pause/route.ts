import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isLeadServiceRequest } from "@/lib/lead-service-auth";
import { PAUSE_REASONS, setFollowUpPause } from "@/lib/lifecycle/pause";

const bodySchema = z
  .object({
    userId: z.string().min(1).max(100),
    action: z.enum(["pause", "resume"]),
    reason: z.enum(PAUSE_REASONS).optional(),
    // When the caller decided this state. Only a decision later than the latest
    // applied one takes effect, so out-of-order and repeated calls are harmless.
    intentAt: z.string().datetime({ offset: true }),
  })
  .strict();

// POST /api/internal/follow-ups/pause
// Pauses or resumes one person's follow-up emails; the lead service calls it when
// outreach starts, when someone presses Pause or Resume on a lead card, and when
// the person posts in their shared channel. Answers where the person now stands,
// including an unsubscribe, which resuming does not clear. Repeating a call
// changes nothing, and each call carries intentAt, when the caller decided it:
// one older than the latest applied is ignored, so a late or retried call can
// never undo a newer one. Its own secret (LIFECYCLE_PAUSE_SECRET), as a bearer token.
export async function POST(request: NextRequest) {
  if (!isLeadServiceRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const { userId, action, reason, intentAt } = parsed.data;
  const result = await setFollowUpPause(userId, action, new Date(intentAt), reason);
  if (!result) return NextResponse.json({ error: "Unknown user" }, { status: 404 });
  console.log(
    `[follow-ups] ${action} for user ${userId}${action === "pause" ? ` (${reason ?? "manual"})` : ""}: ${result.applied ? "applied" : "older than the latest applied, unchanged"}`,
  );
  return NextResponse.json({
    userId,
    paused: result.paused,
    pauseReason: result.pauseReason,
    unsubscribed: result.unsubscribed,
    intentAt: result.intentAt?.toISOString() ?? null,
    applied: result.applied,
  });
}
