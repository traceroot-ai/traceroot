import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleMoveHit } from "@/ee/features/signals/route-handlers";

export const PATCH = withImpersonationPolicy(handleMoveHit);
