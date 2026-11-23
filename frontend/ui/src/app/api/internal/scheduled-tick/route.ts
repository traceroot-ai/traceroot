import { NextRequest, NextResponse } from "next/server";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { reportDailyTraceCounts } from "@/lib/trace-count";

// POST /api/internal/scheduled-tick
//
// The web app's periodic work, called every 15 minutes by the detector service's
// BullMQ job scheduler (frontend/worker/src/web-tick). Each task here is safe to
// run twice and in two overlapping ticks, so the caller may retry freely. Today
// that is each workspace owner's daily trace_count (lib/trace-count.ts).
// Trust is the X-Internal-Secret. Never log ids.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const traceCounts = await reportDailyTraceCounts();
  return NextResponse.json({ traceCounts });
}
