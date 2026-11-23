"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useQuery } from "@tanstack/react-query";
import { getWorkspaces } from "@/lib/api";
import { resolveSetupNeed, onboardingUrlForSetup } from "@/lib/account-setup";

export default function Home() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  // Keyed by account, like /onboarding's copy of this query: one QueryClient
  // lives as long as the tab, so a bare "workspaces" entry would let the
  // previous account's list decide where this one is sent — straight past
  // onboarding, for a new account that has nothing yet. Writers still reach
  // this entry; react-query matches query keys by prefix.
  const { data: workspaces } = useQuery({
    queryKey: ["workspaces", session?.user?.id],
    queryFn: getWorkspaces,
    enabled: !!session?.user?.id,
  });

  useEffect(() => {
    if (!session && !isPending) {
      router.push("/auth/sign-in");
    }
  }, [session, isPending, router]);

  useEffect(() => {
    if (workspaces !== undefined) {
      // Asked through the same predicate /device and /onboarding gate on
      // (lib/account-setup), because counting workspaces was the wrong
      // question: an account that stopped between the two creates owns one and
      // has finished nothing, and sending it to /workspaces showed it a single
      // row that opens on nothing — no traces page, no access key, no snippet,
      // because all three hang off a project. `onboardingUrlForSetup` is what
      // makes the difference actionable: with an empty workspace it asks only
      // for the project, in the same project-only form /device sends this case
      // to, rather than offering a second workspace.
      const need = resolveSetupNeed(workspaces);
      router.push(need === null ? "/workspaces" : onboardingUrlForSetup(need, null));
    }
  }, [workspaces, router]);

  // Always show loading while we determine where to redirect
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">Loading...</p>
    </div>
  );
}
