"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { useQuery } from "@tanstack/react-query";
import { getWorkspaces } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: getWorkspaces,
    enabled: !!session,
  });

  useEffect(() => {
    if (!session && !isPending) {
      router.push("/auth/sign-in");
    }
  }, [session, isPending, router]);

  useEffect(() => {
    if (workspaces !== undefined) {
      if (workspaces.length > 0) {
        router.push("/workspaces");
      } else {
        router.push("/onboarding");
      }
    }
  }, [workspaces, router]);

  // Always show loading while we determine where to redirect
  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-muted-foreground">Loading...</p>
    </div>
  );
}
