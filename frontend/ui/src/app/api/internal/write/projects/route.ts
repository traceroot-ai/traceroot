import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { createProject } from "@/lib/write-services/projects";

// Shape-level checks only: the deep field validation (exact messages, ranges)
// lives in the write service, whose 400s pass through unchanged. Re-declaring
// a range here would shadow the service's message with zod's generic text.
const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  actorUserId: z.string("actorUserId is required").min(1, "actorUserId is required"),
  workspaceId: z.string("workspaceId is required").min(1, "workspaceId is required"),
  name: z.string("name is required").min(1, "name is required"),
  traceTtlDays: z.number().optional(),
  transport: z.enum(["public-api", "agent"]),
  agentSessionId: z.string().min(1).optional(),
});

// POST /api/internal/write/projects — trusted-caller write. The caller
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
  const { actorUserId, workspaceId, name, traceTtlDays, transport, agentSessionId } = parsed.data;
  const result = await createProject({
    actorUserId,
    workspaceId,
    name,
    traceTtlDays,
    provenance: { transport, agentSessionId: agentSessionId ?? null },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ created: result.created, project: result.data });
}
