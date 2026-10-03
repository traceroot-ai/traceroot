import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleSignalCounts } from "@/ee/features/signals/route-handlers";

export const GET = withImpersonationPolicy(handleSignalCounts);
