import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleByTrace } from "@/ee/features/task-groups/route-handlers";

export const GET = withImpersonationPolicy(handleByTrace);
