"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { acceptInvite } from "@/lib/api";

export default function AcceptInvitePage() {
  const params = useParams();
  const router = useRouter();
  const { status } = useSession();
  const inviteId = params.inviteId as string;

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === "loading") return;

    // Not logged in → redirect to login with callback
    if (status === "unauthenticated") {
      router.push(`/auth/sign-in?callbackUrl=/invites/${inviteId}`);
      return;
    }

    // Logged in → accept invite
    const accept = async () => {
      try {
        const result = await acceptInvite(inviteId);
        router.push(`/workspaces/${result.workspace.id}/projects`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to accept invite");
      }
    };

    accept();
  }, [status, inviteId, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md border p-6 text-center">
          <h1 className="text-xl font-semibold">Invitation Error</h1>
          <p className="mt-2 text-muted-foreground">{error}</p>
          <button onClick={() => router.push("/workspaces")} className="mt-4 text-sm underline">
            Go to workspaces
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
        <p className="mt-4 text-muted-foreground">Accepting invitation...</p>
      </div>
    </div>
  );
}
