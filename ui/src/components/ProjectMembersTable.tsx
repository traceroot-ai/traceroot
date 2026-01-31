"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSession } from "next-auth/react";
import { getProjectMembers, updateProjectMemberRole, Role } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { User } from "lucide-react";
import Link from "next/link";

interface ProjectMembersTableProps {
  projectId: string;
  orgId: string;
}

const roleColors: Record<string, string> = {
  OWNER: "bg-purple-100 text-purple-800",
  ADMIN: "bg-blue-100 text-blue-800",
  MEMBER: "bg-green-100 text-green-800",
  VIEWER: "bg-slate-100 text-slate-700",
};

export function ProjectMembersTable({
  projectId,
  orgId,
}: ProjectMembersTableProps) {
  const { data: session } = useSession();
  const queryClient = useQueryClient();

  const {
    data: members,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["projectMembers", projectId],
    queryFn: () => getProjectMembers(projectId),
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({
      orgMembershipId,
      role,
    }: {
      orgMembershipId: string;
      role: Role | null;
    }) => updateProjectMemberRole(projectId, orgMembershipId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projectMembers", projectId],
      });
    },
  });

  if (isLoading) {
    return <p className="text-muted-foreground">Loading members...</p>;
  }

  if (error) {
    return <p className="text-destructive">Error loading members</p>;
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
          const effectiveRole = member.project_role || member.org_role;
          const isOverridden = member.project_role !== null;
          const isCurrentUser = member.user_id === session?.user?.id;

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

              {/* Roles */}
              <div className="flex items-center gap-3">
                {/* Org role (read-only) */}
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Org Role</p>
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${roleColors[member.org_role]}`}
                  >
                    {member.org_role}
                  </span>
                </div>

                {/* Project role (editable) */}
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Project Role</p>
                  <Select
                    value={member.project_role || "INHERIT"}
                    onValueChange={(value) => {
                      const role = value === "INHERIT" ? null : (value as Role);
                      updateRoleMutation.mutate({
                        orgMembershipId: member.id,
                        role,
                      });
                    }}
                    disabled={updateRoleMutation.isPending}
                  >
                    <SelectTrigger className="h-7 w-28 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="INHERIT">
                        <span className="text-muted-foreground">Inherit</span>
                      </SelectItem>
                      <SelectItem value="ADMIN">Admin</SelectItem>
                      <SelectItem value="MEMBER">Member</SelectItem>
                      <SelectItem value="VIEWER">Viewer</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Effective role indicator */}
                {isOverridden && (
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Effective</p>
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${roleColors[effectiveRole]}`}
                    >
                      {effectiveRole}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>

      {/* Footer link */}
      <div className="border-t px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Add or remove members in{" "}
          <Link
            href={`/organizations/${orgId}/settings?tab=members`}
            className="text-primary underline"
          >
            organization settings
          </Link>
        </p>
      </div>
    </Card>
  );
}
