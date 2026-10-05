import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import { createDetector } from "@/lib/write-services/detectors";

// Shape-level checks only: the deep field validation (exact messages, ranges,
// trigger registry) lives in the write service, whose 400s pass through
// unchanged. Re-declaring a range here would shadow the service's message
// with zod's generic text.
const bodySchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  actorUserId: z.string("actorUserId is required").min(1, "actorUserId is required"),
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  name: z.string("name is required").min(1, "name is required"),
  template: z.string("template is required").min(1, "template is required"),
  // Optional at the shape level: the service decides whether an absent prompt
  // is fillable from a standard template or a 400.
  prompt: z.string("prompt is required").min(1, "prompt is required").optional(),
  sampleRate: z.number().optional(),
  // Carry the service's own messages so a non-array is rejected identically
  // whichever surface catches it first.
  outputSchema: z.array(z.unknown(), "outputSchema must be an array").optional(),
  triggerConditions: z.array(z.unknown(), "triggerConditions must be an array").optional(),
  detectionSource: z.union([z.literal("system"), z.literal("byok"), z.null()]).optional(),
  detectionModel: z.string().nullable().optional(),
  detectionProvider: z.string().nullable().optional(),
  enableRca: z.boolean().optional(),
  enabled: z.boolean().optional(),
  transport: z.enum(["public-api", "agent"]),
  agentSessionId: z.string().min(1).optional(),
});

// POST /api/internal/write/detectors — trusted-caller write. The caller
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
  const result = await createDetector({
    ...fields,
    provenance: { transport, agentSessionId: agentSessionId ?? null },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ created: result.created, detector: result.data });
}
