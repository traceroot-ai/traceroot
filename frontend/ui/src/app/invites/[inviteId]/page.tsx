"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { acceptInvite } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";

export default function AcceptInvitePage() {
  const params = useParams();
  const router = useRouter();
  const t = useT();
  const { data: session, isPending } = authClient.useSession();
  const inviteId = params.inviteId as string;

  // `true` when the failure came with no message of its own.
  const [error, setError] = useState<string | true | null>(null);

  useEffect(() => {
    if (isPending) return;

    // Not logged in → redirect to login with callback
    if (!session && !isPending) {
      router.push(`/auth/sign-in?callbackUrl=/invites/${inviteId}`);
      return;
    }

    // Logged in → accept invite
    const accept = async () => {
      try {
        const result = await acceptInvite(inviteId);
        router.push(`/workspaces/${result.workspace.id}/projects`);
      } catch (err) {
        setError(err instanceof Error ? err.message : true);
      }
    };

    accept();
  }, [session, isPending, inviteId, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="max-w-md border p-6 text-center">
          <h1 className="text-[15px] font-medium">{t("invite.errorTitle")}</h1>
          <p className="mt-2 text-muted-foreground">
            {error === true ? t("invite.failed") : error}
          </p>
          <button onClick={() => router.push("/workspaces")} className="mt-4 text-sm underline">
            {t("invite.goToWorkspaces")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
        <p className="mt-4 text-muted-foreground">{t("invite.accepting")}</p>
      </div>
    </div>
  );
}
