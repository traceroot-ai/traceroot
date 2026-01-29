"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getOrganization,
  getMembers,
  deleteProject,
  removeMember,
  type Role,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateProjectDialog } from "@/components/CreateProjectDialog";
import {
  ArrowLeft,
  Building2,
  FolderOpen,
  MoreVertical,
  Trash2,
  Users,
} from "lucide-react";
import Link from "next/link";

const roleColors: Record<string, string> = {
  OWNER: "bg-gray-900 text-white",
  ADMIN: "bg-gray-700 text-white",
  MEMBER: "bg-gray-200 text-gray-800",
  VIEWER: "bg-gray-100 text-gray-600",
};

function canManageMembers(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

function canDeleteProject(role: Role): boolean {
  return role === "OWNER" || role === "ADMIN";
}

export default function OrganizationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const orgId = params.orgId as string;
  const { data: session, status } = useSession();
  const user = session?.user;

  useEffect(() => {
    if (!user) {
      router.push("/");
    }
  }, [user, router]);

  const { data: org, isLoading: orgLoading, error: orgError } = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: !!user && !!orgId,
  });

  const { data: members, isLoading: membersLoading } = useQuery({
    queryKey: ["members", orgId],
    queryFn: () => getMembers(orgId),
    enabled: !!user && !!orgId && !!org && canManageMembers(org.role),
  });

  const deleteProjectMutation = useMutation({
    mutationFn: (projectId: string) => deleteProject(orgId, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => removeMember(orgId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", orgId] });
    },
  });

  if (!user) {
    return null;
  }

  if (orgLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading organization...</p>
      </div>
    );
  }

  if (orgError || !org) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <p className="text-destructive">
            {orgError?.message || "Organization not found"}
          </p>
          <Link href="/organizations">
            <Button variant="outline" className="mt-4">
              Back to Organizations
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-4xl p-6">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/organizations"
            className="mb-4 inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Organizations
          </Link>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-100">
                <Building2 className="h-6 w-6 text-gray-600" />
              </div>
              <div>
                <h1 className="text-2xl font-bold">{org.name}</h1>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      roleColors[org.role] || roleColors.VIEWER
                    }`}
                  >
                    {org.role}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Created {new Date(org.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </div>
            <CreateProjectDialog orgId={orgId} />
          </div>
        </div>

        {/* Projects Section */}
        <section className="mb-8">
          <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
            <FolderOpen className="h-5 w-5" />
            Projects ({org.projects.length})
          </h2>
          {org.projects.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-12">
                <FolderOpen className="mb-4 h-12 w-12 text-muted-foreground" />
                <h3 className="mb-2 text-lg font-medium">No projects yet</h3>
                <p className="mb-4 text-muted-foreground">
                  Create your first project to start tracking traces.
                </p>
                <CreateProjectDialog orgId={orgId} />
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {org.projects.map((project) => (
                <Card key={project.id} className="relative">
                  <CardHeader>
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-base">{project.name}</CardTitle>
                        <CardDescription>
                          Created {new Date(project.created_at).toLocaleDateString()}
                        </CardDescription>
                      </div>
                      {canDeleteProject(org.role) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => {
                            if (confirm(`Delete project "${project.name}"?`)) {
                              deleteProjectMutation.mutate(project.id);
                            }
                          }}
                          disabled={deleteProjectMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Link href={`/${project.id}/traces`}>
                      <Button variant="outline" size="sm" className="w-full">
                        View Traces
                      </Button>
                    </Link>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>

        {/* Members Section */}
        {canManageMembers(org.role) && (
          <section>
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold">
              <Users className="h-5 w-5" />
              Members {members && `(${members.length})`}
            </h2>
            {membersLoading ? (
              <p className="text-muted-foreground">Loading members...</p>
            ) : members && members.length > 0 ? (
              <Card>
                <CardContent className="divide-y p-0">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between p-4"
                    >
                      <div>
                        <p className="font-medium">
                          {member.name || member.email || "Unknown"}
                        </p>
                        {member.name && (
                          <p className="text-sm text-muted-foreground">
                            {member.email}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            roleColors[member.role] || roleColors.VIEWER
                          }`}
                        >
                          {member.role}
                        </span>
                        {member.user_id !== user?.id && member.role !== "OWNER" && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              if (
                                confirm(
                                  `Remove ${member.name || member.email} from the organization?`
                                )
                              ) {
                                removeMemberMutation.mutate(member.user_id);
                              }
                            }}
                            disabled={removeMemberMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : (
              <Card>
                <CardContent className="py-8 text-center">
                  <p className="text-muted-foreground">No members found</p>
                </CardContent>
              </Card>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
