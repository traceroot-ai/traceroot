import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { createWorkspace } from "@/lib/write-services/workspaces";

const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  actorUserId: z.string("actorUserId is required").min(1, "actorUserId is required"),
  name: z.string("name is required").min(1, "name is required"),
  transport: z.enum(["public-api", "agent"]),
  agentSessionId: z.string().min(1).optional(),
});

// POST /api/internal/write/workspaces — trusted-caller write. The caller
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
  const { actorUserId, name, transport, agentSessionId } = parsed.data;
  const result = await createWorkspace({
    actorUserId,
    name,
    provenance: { transport, agentSessionId: agentSessionId ?? null },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ created: result.created, workspace: result.data });
}
