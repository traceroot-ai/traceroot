import type { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import {
  errorResponse,
  requireAuth,
  requireProjectAccess,
  type AuthenticatedUser,
  type Role,
} from "@/lib/auth-helpers";

/**
 * Require an authenticated user with access to the project named in the
 * route's params. Resolves the params promise so callers can destructure any
 * additional route segments off `params`.
 *
 * Pass `minRole` on every mutating handler — without it a VIEWER-role member
 * passes the membership check and can write.
 */
export async function requireProjectAuth<P extends { projectId: string }>(
  params: Promise<P>,
  minRole?: Role,
): Promise<
  | { user: AuthenticatedUser; params: P; error?: never }
  | { user?: never; params?: never; error: NextResponse }
> {
  const authResult = await requireAuth();
  if (authResult.error) return { error: authResult.error };
  const resolved = await params;
  const accessResult = await requireProjectAccess(authResult.user.id, resolved.projectId, minRole);
  if (accessResult.error) return { error: accessResult.error };
  return { user: authResult.user, params: resolved };
}

/**
 * Parse a request body as a JSON object. Rejects invalid JSON and payloads
 * that aren't destructure-friendly (null, arrays, scalars).
 */
export async function parseJsonObject(
  req: Request,
): Promise<
  { body: Record<string, unknown>; error?: never } | { body?: never; error: NextResponse }
> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return { error: errorResponse("Invalid JSON", 400) };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { error: errorResponse("Body must be a JSON object", 400) };
  }
  return { body: body as Record<string, unknown> };
}

/**
 * True when a Prisma mutation failed because the row was already gone —
 * a concurrent delete between a scoped findFirst and the write. Callers map
 * this to a 404 instead of letting it bubble as a 500.
 */
export function isRecordGone(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}
