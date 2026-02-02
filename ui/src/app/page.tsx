"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useQuery } from "@tanstack/react-query";
import { getWorkspaces } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const { status } = useSession();

  const { data: workspaces } = useQuery({
    queryKey: ["workspaces"],
    queryFn: getWorkspaces,
    enabled: status === "authenticated",
  });

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/auth/sign-in");
    }
  }, [status, router]);

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
