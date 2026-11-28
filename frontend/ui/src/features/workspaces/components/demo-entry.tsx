"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchNextApi } from "@/lib/api/client";
import { useDemoAccess } from "@/features/workspaces/hooks/use-demo-access";
import { useSession } from "@/lib/auth-client";

export function DemoEntry() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const demo = useDemoAccess();
  const { data: session, isPending: sessionPending } = useSession();
  const join = useMutation({
    mutationFn: () => fetchNextApi<{ projectId: string }>("/demo", { method: "POST" }),
    onSuccess: ({ projectId }) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["demo"] });
      router.push(`/projects/${encodeURIComponent(projectId)}/traces`);
    },
  });
  const leave = useMutation({
    mutationFn: () => fetchNextApi("/demo", { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      void queryClient.invalidateQueries({ queryKey: ["demo"] });
    },
  });
  const error = demo.error ?? join.error ?? leave.error;
  const busy = join.isPending || leave.isPending;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-base">Explore the demo</CardTitle>
          <CardDescription>
            Join a shared, read-only workspace with sample traces, public detector templates and
            dashboards. Your own workspaces stay separate.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(sessionPending || (session && demo.isPending)) && (
            <p className="text-sm text-muted-foreground">Loading demo...</p>
          )}
          {!sessionPending && !session && (
            <Link
              href="/auth/sign-in?callbackUrl=%2Fdemo"
              className={buttonVariants({ variant: "outline" })}
            >
              Sign in to explore the demo
            </Link>
          )}
          {demo.data && !demo.data.available && (
            <p className="text-sm text-muted-foreground">
              The demo is not available on this deployment.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error.message}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {demo.data?.available && (
              <Button onClick={() => join.mutate()} disabled={busy} className="text-primary-ink">
                {join.isPending ? "Opening demo..." : demo.data.joined ? "Open demo" : "Join demo"}
              </Button>
            )}
            {demo.data?.canLeave && (
              <Button variant="outline" onClick={() => leave.mutate()} disabled={busy}>
                {leave.isPending ? "Leaving demo..." : "Leave demo"}
              </Button>
            )}
            <Link href="/workspaces" className={buttonVariants({ variant: "ghost" })}>
              Back to workspaces
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
