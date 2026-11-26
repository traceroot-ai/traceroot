import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { startFirstTraceTracking } from "@/lib/first-trace-backfill";

const trackingStartSchema = z.object({
  startedAt: z.iso.datetime({
    offset: true,
    error: "startedAt must be an ISO-8601 time with an offset",
  }),
});

// POST /api/internal/first-trace-tracking
//
// The ingest worker's notice that it has started reporting trace activity: sent as
// it starts with reporting enabled, and before its first report if that did not get
// through. `startedAt` is when it started, before it stored any batch, so it is the
// cutoff between projects that already had traces and projects receiving their
// first (lib/first-trace-backfill.ts). The first cutoff recorded is kept, whatever
// later notices say; the answer is the recorded one. Trust is the X-Internal-Secret.
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

  const parsed = trackingStartSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const startedAt = await startFirstTraceTracking(new Date(parsed.data.startedAt));
  return NextResponse.json({ startedAt: startedAt.toISOString() });
}
