import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleMergeSignal } from "@/ee/features/signals/route-handlers";

export const POST = withImpersonationPolicy(handleMergeSignal);
