import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleEditSignal, handleGetSignal } from "@/ee/features/signals/route-handlers";

export const GET = withImpersonationPolicy(handleGetSignal);
export const PATCH = withImpersonationPolicy(handleEditSignal);
