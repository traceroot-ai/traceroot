import { NextResponse } from "next/server";

// GET /api/health
//
// Liveness endpoint for the load balancer and kubelet probes. Deliberately
// touches nothing (no database, no auth): it answers "the web process is up
// and serving", not "every dependency is healthy". A dependency check here
// would take the whole web tier out of rotation when, say, Postgres blips,
// which is the opposite of what a liveness probe is for.
//
// Exempt from the session middleware in proxy.ts; without that, the probe
// gets a 307 to /auth/sign-in, which the ALB counts as unhealthy.
export function GET() {
  return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
