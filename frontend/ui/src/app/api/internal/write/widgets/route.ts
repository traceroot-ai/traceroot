import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { createWidget } from "@/lib/write-services/dashboards";

// Shape-level checks only: the deep field validation (length caps, exact
// messages) lives in the write service, whose 400s pass through unchanged.
const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  actorUserId: z.string("actorUserId is required").min(1, "actorUserId is required"),
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  dashboardId: z.string("dashboardId is required").min(1, "dashboardId is required"),
  title: z.string("title is required").min(1, "title is required"),
  type: z.enum(["query", "trace_feed"]),
  spec: z.record(z.string(), z.unknown()),
  displayConfig: z.record(z.string(), z.unknown()).optional(),
  transport: z.enum(["public-api", "agent"]),
  agentSessionId: z.string().min(1).optional(),
});

// POST /api/internal/write/widgets — trusted-caller write. The caller
// (the public API route or the agent binding) has already authenticated the
// actor; trust is the X-Internal-Secret plus that verified identity. The
// role/validation decision itself lives in the write service. Never log ids.
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
  const { transport, agentSessionId, ...fields } = parsed.data;
  const result = await createWidget({
    ...fields,
    provenance: { transport, agentSessionId: agentSessionId ?? null },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ created: result.created, widget: result.data });
}
