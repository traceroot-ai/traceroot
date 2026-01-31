"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { getMembers, updateMemberRole, removeMember, Role } from "@/lib/api";
import { useHasOrganizationAccess } from "@/hooks/useOrgAccess";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, User } from "lucide-react";

interface MembersTableProps {
  orgId: string;
}

const roleColors: Record<Role, string> = {
  OWNER: "bg-purple-100 text-purple-800",
  ADMIN: "bg-blue-100 text-blue-800",
  MEMBER: "bg-green-100 text-green-800",
  VIEWER: "bg-gray-100 text-gray-800",
};

const roleDescriptions: Record<Role, string> = {
  OWNER: "Full control",
  ADMIN: "Manage members & projects",
  MEMBER: "Create projects",
  VIEWER: "View only",
};

export function MembersTable({ orgId }: MembersTableProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const canEdit = useHasOrganizationAccess({
    orgId,
    scope: "organizationMembers:CUD",
  });

  const {
    data: members,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => getMembers(orgId),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      updateMemberRole(orgId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", orgId] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeMember(orgId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", orgId] });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });

  if (isLoading) {
    return <p className="text-muted-foreground">Loading members...</p>;
  }

  if (error) {
    return (
      <p className="text-destructive">Error loading members: {error.message}</p>
    );
  }

  if (!members || members.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-muted-foreground">No members found</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="divide-y p-0">
        {members.map((member) => {
          const isCurrentUser = member.user_id === session?.user?.id;
          const isOwner = member.role === "OWNER";
          const canEditRole = canEdit && !isOwner;
          const canRemove = canEdit && !isOwner && !isCurrentUser;
          const canLeave = isCurrentUser && !isOwner;

          return (
            <div
              key={member.id}
              className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              {/* Member info */}
              <div className="flex items-center gap-3">
                {member.image ? (
                  <img
                    src={member.image}
                    alt={member.name || "User"}
                    className="h-10 w-10 rounded-full"
                  />
                ) : (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-200">
                    <User className="h-5 w-5 text-gray-500" />
                  </div>
                )}
                <div>
                  <p className="font-medium">
                    {member.name || member.email || "Unknown"}
                    {isCurrentUser && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        (you)
                      </span>
                    )}
                  </p>
                  {member.name && member.email && (
                    <p className="text-sm text-muted-foreground">
                      {member.email}
                    </p>
                  )}
                </div>
              </div>

              {/* Role and actions */}
              <div className="flex items-center gap-2">
                {canEditRole ? (
                  <Select
                    value={member.role}
                    onValueChange={(role) => {
                      const confirmed = isCurrentUser
                        ? confirm(
                            "Are you sure you want to change your own role?",
                          )
                        : true;
                      if (confirmed) {
                        updateRoleMutation.mutate({
                          userId: member.user_id,
                          role: role as Role,
                        });
                      }
                    }}
                    disabled={updateRoleMutation.isPending}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ADMIN">Admin</SelectItem>
                      <SelectItem value="MEMBER">Member</SelectItem>
                      <SelectItem value="VIEWER">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-medium ${roleColors[member.role]}`}
                    title={roleDescriptions[member.role]}
                  >
                    {member.role}
                  </span>
                )}

                {(canRemove || canLeave) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      const message = canLeave
                        ? "Are you sure you want to leave this organization?"
                        : `Remove ${member.name || member.email} from the organization?`;
                      if (confirm(message)) {
                        removeMutation.mutate(member.user_id);
                      }
                    }}
                    disabled={removeMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
