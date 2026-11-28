import { demoWorkspaceId } from "@/lib/demo-workspace";

/** The explicit demo entry page, or the app when no demo is configured. */
export async function demoProjectUrl(appUrl: string): Promise<string> {
  return demoWorkspaceId() ? new URL("/demo", appUrl).toString() : appUrl;
}
