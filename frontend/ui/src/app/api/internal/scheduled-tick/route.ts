import { NextRequest, NextResponse } from "next/server";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { runFollowUps } from "@/lib/lifecycle/follow-up-job";
import { reportDailyTraceCounts } from "@/lib/trace-count";

// POST /api/internal/scheduled-tick
//
// The web app's periodic work, called every 15 minutes by the detector service's
// BullMQ job scheduler (frontend/worker/src/web-tick). Each task here is safe to
// run twice and in two overlapping ticks, so the caller may retry freely: each
// workspace owner's daily trace_count (lib/trace-count.ts), and the follow-up
// emails (lib/lifecycle/follow-up-job.ts, off unless enabled). Each task catches
// its own failure, so one failing never stops the others. Trust is the X-Internal-Secret. Never log addresses.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const traceCounts = await reportDailyTraceCounts().catch((error: unknown) => {
    console.error(`[trace-count] daily report failed: ${String(error)}`);
    return { error: "failed" as const };
  });
  const followUps = await runFollowUps().catch((error: unknown) => {
    console.error(`[follow-ups] run failed: ${String(error)}`);
    return { error: "failed" as const };
  });
  return NextResponse.json({ traceCounts, followUps });
}
