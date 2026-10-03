import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleListDetectorSignals } from "@/ee/features/signals/route-handlers";

export const GET = withImpersonationPolicy(handleListDetectorSignals);
