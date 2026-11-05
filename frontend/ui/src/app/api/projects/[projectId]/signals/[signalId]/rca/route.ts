import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleRequestSignalRca } from "@/ee/features/signals/route-handlers";

export const POST = withImpersonationPolicy(handleRequestSignalRca);
