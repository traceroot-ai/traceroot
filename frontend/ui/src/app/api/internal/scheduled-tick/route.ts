import { NextRequest, NextResponse } from "next/server";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { runFollowUps } from "@/lib/lifecycle/follow-up-job";
import { runWelcomeFallback } from "@/lib/email/welcome/welcome-schedule";
import { reportDailyTraceCounts } from "@/lib/trace-count";

// POST /api/internal/scheduled-tick
//
// The web app's periodic work, called every 15 minutes by the detector service's
// BullMQ job scheduler (frontend/worker/src/web-tick). Each task here is safe to
// run twice and in two overlapping ticks, so the caller may retry freely: each
// workspace owner's daily trace_count (lib/trace-count.ts), the welcome emails
// that fell due without the sign-up questions sending them
// (lib/email/welcome/welcome-schedule.ts, cloud only), and the follow-up emails
// (lib/lifecycle/follow-up-job.ts, off unless enabled). The welcome runs before
// the follow-ups, which only go to people who have had it. One failing does not
// stop the others. Trust is the X-Internal-Secret. Never log addresses.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const traceCounts = await reportDailyTraceCounts();
  const welcomes = await runWelcomeFallback().catch((error: unknown) => {
    console.error(`[welcome] scheduled run failed: ${String(error)}`);
    return { error: "failed" as const };
  });
  const followUps = await runFollowUps().catch((error: unknown) => {
    console.error(`[follow-ups] run failed: ${String(error)}`);
    return { error: "failed" as const };
  });
  return NextResponse.json({ traceCounts, welcomes, followUps });
}
