import { createHash, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import { env } from "@/env";

/**
 * The lead service's credential for the internal endpoints it calls: its own
 * secret (LIFECYCLE_PAUSE_SECRET), as a bearer token. Not INTERNAL_API_SECRET,
 * which can act as any user. Blank turns those endpoints off.
 */
export function isLeadServiceRequest(request: NextRequest): boolean {
  const expected = env.LIFECYCLE_PAUSE_SECRET;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!expected || !provided) return false;
  return timingSafeEqual(
    createHash("sha256").update(provided).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
