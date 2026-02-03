'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { acceptInvite } from '@/lib/api';

export default function AcceptInvitePage() {
  const params = useParams();
  const router = useRouter();
  const { status } = useSession();
  const inviteId = params.inviteId as string;

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (status === 'loading') return;

    // Not logged in → redirect to login with callback
    if (status === 'unauthenticated') {
      router.push(`/auth/sign-in?callbackUrl=/invites/${inviteId}`);
      return;
    }

    // Logged in → accept invite
    const accept = async () => {
      try {
        const result = await acceptInvite(inviteId);
        router.push(`/workspaces/${result.workspace.id}/projects`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to accept invite');
      }
    };

    accept();
  }, [status, inviteId, router]);

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="max-w-md p-6 border text-center">
          <h1 className="text-xl font-semibold">Invitation Error</h1>
          <p className="text-muted-foreground mt-2">{error}</p>
          <button
            onClick={() => router.push('/workspaces')}
            className="mt-4 text-sm underline"
          >
            Go to workspaces
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <div className="text-center">
        <div className="animate-spin h-8 w-8 border-2 border-foreground border-t-transparent rounded-full mx-auto" />
        <p className="mt-4 text-muted-foreground">Accepting invitation...</p>
      </div>
    </div>
  );
}
