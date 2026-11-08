import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleOverview } from "@/ee/features/task-groups/route-handlers";

export const GET = withImpersonationPolicy(handleOverview);
