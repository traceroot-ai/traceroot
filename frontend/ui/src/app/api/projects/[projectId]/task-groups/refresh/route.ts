import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleRefresh } from "@/ee/features/task-groups/route-handlers";

export const POST = withImpersonationPolicy(handleRefresh);
