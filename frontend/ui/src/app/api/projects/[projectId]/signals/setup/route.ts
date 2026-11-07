import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleSignalSetup } from "@/ee/features/signals/route-handlers";

export const GET = withImpersonationPolicy(handleSignalSetup);
