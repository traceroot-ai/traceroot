import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleSetSignalStatus } from "@/ee/features/signals/route-handlers";

export const POST = withImpersonationPolicy(handleSetSignalStatus);
