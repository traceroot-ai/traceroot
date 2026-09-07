import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { createDashboard } from "@/lib/write-services/dashboards";

// Shape-level checks only: the deep field validation (length caps, exact
// messages) lives in the write service, whose 400s pass through unchanged.
const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  actorUserId: z.string("actorUserId is required").min(1, "actorUserId is required"),
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  name: z.string("name is required").min(1, "name is required"),
  description: z.string().nullable().optional(),
  transport: z.enum(["public-api", "agent"]),
  agentSessionId: z.string().min(1).optional(),
});

// POST /api/internal/write/dashboards — trusted-caller write. The caller
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
  const result = await createDashboard({
    ...fields,
    provenance: { transport, agentSessionId: agentSessionId ?? null },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    created: result.created,
    dashboard: result.data,
    // Present only when the service had to pick a different name than the
    // one requested; the agent tool turns it into the "renamed" receipt.
    ...(result.renamedFrom === undefined ? {} : { renamedFrom: result.renamedFrom }),
  });
}
