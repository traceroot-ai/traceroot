/** The gate every Loop API route passes first. */
import type { NextResponse } from "next/server";
import { prisma } from "@traceroot/core";
import { errorResponse, type AuthenticatedUser, type Role } from "@/lib/auth-helpers";
import { isLoopsEnabled } from "@/lib/loops-enabled";
import { requireProjectAuth } from "@/lib/route-helpers";

type LoopRouteAuth<P, L> =
  | { user: AuthenticatedUser; projectId: string; loop: L; params: P; error?: never }
  | { user?: never; projectId?: never; loop?: never; params?: never; error: NextResponse };

/** The Loop a route under /loops/[loopId] acts on. */
export type LoopRef = { id: string; detectorId: string };

/**
 * 404 while LOOPS_ENABLED is off, then requireProjectAuth (pass `minRole` on
 * writes), then, under /loops/[loopId], the Loop itself: 404 when the project
 * has no such Loop.
 */
export function requireLoopRoute<P extends { projectId: string; loopId: string }>(
  params: Promise<P>,
  minRole?: Role,
): Promise<LoopRouteAuth<P, LoopRef>>;
export function requireLoopRoute<P extends { projectId: string }>(
  params: Promise<P>,
  minRole?: Role,
): Promise<LoopRouteAuth<P, null>>;
export async function requireLoopRoute(
  params: Promise<{ projectId: string; loopId?: string }>,
  minRole?: Role,
): Promise<LoopRouteAuth<{ projectId: string; loopId?: string }, LoopRef | null>> {
  if (!isLoopsEnabled()) return { error: errorResponse("Not found", 404) };
  const auth = await requireProjectAuth(params, minRole);
  if (auth.error) return { error: auth.error };
  const { projectId, loopId } = auth.params;
  let loop: LoopRef | null = null;
  if (loopId !== undefined) {
    loop = await prisma.loop.findFirst({
      where: { id: loopId, projectId },
      select: { id: true, detectorId: true },
    });
    if (!loop) return { error: errorResponse("Loop not found", 404) };
  }
  return { user: auth.user, projectId, loop, params: auth.params };
}
