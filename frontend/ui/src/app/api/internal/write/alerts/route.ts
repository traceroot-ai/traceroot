import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { createAlert } from "@/lib/write-services/alerts";

// Envelope-level checks only: the rule itself is validated by the write
// service (the same validator the cookie route runs), whose 400s pass
// through unchanged.
const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  actorUserId: z.string("actorUserId is required").min(1, "actorUserId is required"),
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  transport: z.enum(["public-api", "agent"]),
  agentSessionId: z.string().min(1).optional(),
});

// POST /api/internal/write/alerts — trusted-caller write. The caller (the
// public API route or the agent binding) has already authenticated the actor;
// trust is the X-Internal-Secret plus that verified identity. The
// role/validation/cap decision itself lives in the write service. Never log
// ids.
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
  const { actorUserId, projectId, transport, agentSessionId } = parsed.data;
  // The envelope fields ride alongside the rule in one flat body; the rule
  // schema ignores keys it does not declare, so they never reach storage.
  const result = await createAlert({
    actorUserId,
    projectId,
    rule: body,
    provenance: { transport, agentSessionId: agentSessionId ?? null },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ created: result.created, alert: result.data });
}
