"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Building2, Check, X } from "lucide-react";

// Add these to api.ts
async function getMyInvitations() {
  const res = await fetch("/api/invitations");
  if (!res.ok) throw new Error("Failed to fetch");
  return res.json();
}

async function respondToInvitation(invitationId: string, accept: boolean) {
  const res = await fetch(`/api/invitations/${invitationId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accept }),
  });
  if (!res.ok) throw new Error("Failed to respond");
  return res.json();
}

export default function InvitationsPage() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  const { data: invitations, isLoading } = useQuery({
    queryKey: ["myInvitations"],
    queryFn: getMyInvitations,
    enabled: !!session?.user,
  });

  const respondMutation = useMutation({
    mutationFn: ({ id, accept }: { id: string; accept: boolean }) =>
      respondToInvitation(id, accept),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["myInvitations"] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });

  if (isLoading) return <p>Loading...</p>;

  if (!invitations?.data?.length) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="text-2xl font-bold mb-4">Invitations</h1>
        <p className="text-muted-foreground">No pending invitations</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-bold mb-6">Pending Invitations</h1>
      <div className="space-y-4">
        {invitations.data.map((inv: any) => (
          <Card key={inv.id}>
            <CardHeader>
              <div className="flex items-center gap-3">
                <Building2 className="h-5 w-5 text-primary" />
                <div>
                  <CardTitle>{inv.organization.name}</CardTitle>
                  <CardDescription>Role: {inv.org_role}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button
                onClick={() =>
                  respondMutation.mutate({ id: inv.id, accept: true })
                }
                disabled={respondMutation.isPending}
              >
                <Check className="mr-2 h-4 w-4" />
                Accept
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  respondMutation.mutate({ id: inv.id, accept: false })
                }
                disabled={respondMutation.isPending}
              >
                <X className="mr-2 h-4 w-4" />
                Decline
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
