import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleListSignals } from "@/ee/features/signals/route-handlers";

export const GET = withImpersonationPolicy(handleListSignals);
