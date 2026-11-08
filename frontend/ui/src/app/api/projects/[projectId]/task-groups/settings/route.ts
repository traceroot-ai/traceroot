import { withImpersonationPolicy } from "@/lib/support/route-guard";
import { handleUpdateSettings } from "@/ee/features/task-groups/route-handlers";

export const PUT = withImpersonationPolicy(handleUpdateSettings);
