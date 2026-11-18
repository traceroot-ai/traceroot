import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { recordTraceActivity } from "@/lib/trace-activity";

const traceActivitySchema = z.object({
  // The message on z.string() covers a missing or non-string id as well.
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  // The UTC day the API received the batch, which the worker keeps through retries.
  // Optional: a report from a worker that sends none counts the day it arrives.
  day: z.iso.date({ error: "day must be YYYY-MM-DD" }).optional(),
});

// POST /api/internal/trace-activity
//
// The ingest worker's report that a project received traces: sent after it has
// written at least one span of a batch, so a batch that fails to decode never
// counts. Records the project's first trace and the owner's active day for the
// day the report names (see lib/trace-activity.ts). Every write is conditional,
// so a repeated report changes nothing and the caller may retry freely;
// ingestion never waits on it.
// A project's first trace is placed against the cutoff the worker records before
// its first report (POST /api/internal/first-trace-tracking); without one the
// report is refused with 409 and changes nothing, and the worker records its start
// and retries. Trust is the X-Internal-Secret. Never log ids.
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

  const parsed = traceActivitySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { projectId, day } = parsed.data;
  const outcome = await recordTraceActivity(
    projectId,
    new Date(),
    day ? new Date(`${day}T00:00:00.000Z`) : undefined,
  );
  switch (outcome.kind) {
    case "unknown_project":
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    case "demo_project":
      return NextResponse.json({ recorded: false });
    case "tracking_not_started":
      return NextResponse.json({ error: "First-trace tracking has not started" }, { status: 409 });
    case "recorded":
      return NextResponse.json({
        recorded: true,
        firstTrace: outcome.firstTrace,
        activeDayCounted: outcome.activeDayCounted,
        activeFirstWeek: outcome.activeFirstWeek,
      });
  }
}
