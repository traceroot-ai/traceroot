/**
 * The contract every internal write route shares. The caller (the public API
 * route or the agent binding, and through the cookie routes the web app) has
 * already authenticated the actor; trust is the X-Internal-Secret plus that
 * verified identity. The role and validation decisions live in the write
 * service, whose 400s pass through unchanged, so the schemas here are
 * shape-level only: re-declaring a range would shadow the service's message
 * with zod's generic text. Never log ids.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { verifyInternalSecret } from "@/lib/auth-helpers";
import type { Provenance } from "@/lib/write-services/types";

/** The string-typed error covers missing/wrong-type input too, so the
 *  surfaced message is deterministic whether the field is absent or empty. */
export const requiredId = (field: string) =>
  z.string(`${field} is required`).min(1, `${field} is required`);

/** The envelope beside the resource fields: who acts, and over which transport. */
export const envelopeShape = {
  actorUserId: requiredId("actorUserId"),
  transport: z.enum(["public-api", "agent", "ui"]),
  agentSessionId: z.string().min(1).optional(),
};

/** The envelope of a project-scoped write. */
export const projectEnvelopeShape = { ...envelopeShape, projectId: requiredId("projectId") };

export type ParsedInternalWrite<S extends z.ZodType> =
  | { ok: true; data: z.output<S>; raw: unknown }
  | { ok: false; response: NextResponse };

/**
 * Secret check, JSON parse, then the envelope-plus-fields schema, each
 * answered with the same status and message every internal write uses.
 * `raw` is the parsed body before the schema, for routes that forward it
 * whole (the alert rule rides beside the envelope in one flat body).
 */
export async function parseInternalWrite<S extends z.ZodType>(
  request: NextRequest,
  schema: S,
): Promise<ParsedInternalWrite<S>> {
  if (!verifyInternalSecret(request)) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 }),
    };
  }
  return { ok: true, data: parsed.data, raw };
}

export function provenanceOf(envelope: {
  transport: Provenance["transport"];
  agentSessionId?: string;
}): Provenance {
  return { transport: envelope.transport, agentSessionId: envelope.agentSessionId ?? null };
}

export function serviceErrorResponse(result: { status: number; error: string }): NextResponse {
  return NextResponse.json({ error: result.error }, { status: result.status });
}
