import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleTraceSignals } from "@/ee/features/signals/route-handlers";

export const GET = withImpersonationPolicy(handleTraceSignals);
