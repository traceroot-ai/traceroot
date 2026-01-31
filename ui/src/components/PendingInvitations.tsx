"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getInvitations, deleteInvitation, Role } from "@/lib/api";
import { useHasOrganizationAccess } from "@/hooks/useOrgAccess";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Mail, Trash2, Clock } from "lucide-react";

interface PendingInvitationsProps {
  orgId: string;
}

const roleColors: Record<Role, string> = {
  OWNER: "bg-purple-100 text-purple-800",
  ADMIN: "bg-blue-100 text-blue-800",
  MEMBER: "bg-green-100 text-green-800",
  VIEWER: "bg-gray-100 text-gray-800",
};

export function PendingInvitations({ orgId }: PendingInvitationsProps) {
  const queryClient = useQueryClient();
  const canManage = useHasOrganizationAccess({
    orgId,
    scope: "invitations:CUD",
  });

  const { data: invitations, isLoading } = useQuery({
    queryKey: ["invitations", orgId],
    queryFn: () => getInvitations(orgId),
    enabled: canManage,
  });

  const deleteMutation = useMutation({
    mutationFn: (invitationId: string) => deleteInvitation(orgId, invitationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["invitations", orgId] });
    },
  });

  // Don't render if user can't manage invitations
  if (!canManage) return null;

  // Don't render while loading
  if (isLoading) return null;

  // Don't render if no pending invitations
  if (!invitations || invitations.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Clock className="h-4 w-4" />
          Pending Invitations
        </CardTitle>
        <CardDescription>
          These users will be added to the organization when they sign up or log
          in
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y p-0">
        {invitations.map((invitation) => (
          <div
            key={invitation.id}
            className="flex items-center justify-between p-4"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100">
                <Mail className="h-4 w-4 text-gray-500" />
              </div>
              <div>
                <p className="font-medium">{invitation.email}</p>
                <p className="text-xs text-muted-foreground">
                  Invited {new Date(invitation.created_at).toLocaleDateString()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${roleColors[invitation.org_role]}`}
              >
                {invitation.org_role}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (confirm(`Cancel invitation for ${invitation.email}?`)) {
                    deleteMutation.mutate(invitation.id);
                  }
                }}
                disabled={deleteMutation.isPending}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
