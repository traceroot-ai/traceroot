import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleTraceSignalIds } from "@/ee/features/signals/route-handlers";

export const GET = withImpersonationPolicy(handleTraceSignalIds);
